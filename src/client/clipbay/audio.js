/**
 * Playback (plan M5.3).
 *
 * The rule that shapes this file: playback must use the same parameters the
 * renderer uses (plan M5, "预览与导出必须用同一套参数语义"). So gain is
 * `track.volumeDb + item.gainDb`, pan is `clamp(item.pan + track.pan)`, mute and
 * solo resolve the same way, and fades come from the same fadeInSec/fadeOutSec.
 *
 * One AudioContext clock drives every clip: each `start()` is scheduled against
 * a single `startedAt` timestamp, so clips cannot drift apart the way separate
 * timers would. The playhead only samples that clock.
 *
 * Materials are decoded lazily and one at a time; a 15-minute stereo material is
 * ~346 MB as Float32, so nothing is preloaded (spec §14.1).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { API } from '../api.js'

/** Audible tracks: solo wins over everything, then mute removes one track. */
export function audibleTracks(tracks) {
  const list = tracks ?? []
  const soloed = list.filter((track) => track.solo)
  const pool = soloed.length > 0 ? soloed : list
  return pool.filter((track) => !track.muted)
}

export function dbToGain(db) {
  const value = Number(db) || 0
  return value === 0 ? 1 : 10 ** (value / 20)
}

/** Time constant for a live gain move: short enough to feel immediate, long
 * enough that a step does not click. `setTargetAtTime` reaches ~95% in 3τ. */
export const TARGET_TAU_SEC = 0.01

/**
 * The gain of one track, as the renderer computes it.
 *
 * Mute wins over solo, and while anything is soloed every other track is silent.
 * Returned as a number (not a boolean) so the same expression can drive both the
 * scheduled graph and a live update — preview and export must agree (plan M5).
 */
export function resolveTrackGain(track, anySolo) {
  if (!track || track.muted) return 0
  if (anySolo && !track.solo) return 0
  return dbToGain(track.volumeDb)
}

/**
 * The gain of one clip right now: track gain times clip gain, or zero when the
 * clip or its track is muted. Reading it from the live project is what makes a
 * fader move audible without restarting playback.
 */
export function mixedGain(project, trackId, itemId) {
  const tracks = project?.tracks ?? []
  const anySolo = tracks.some((track) => track.solo)
  const track = tracks.find((entry) => entry.id === trackId)
  const item = track?.items?.find((entry) => entry.id === itemId)
  if (!track || !item || item.muted) return 0
  return resolveTrackGain(track, anySolo) * dbToGain(item.gainDb)
}

/**
 * Build the clips to schedule. Pure, so the numbers can be checked without an
 * AudioContext.
 *
 * `fromSec` is where playback begins; a clip that already ended is dropped, and
 * one that started earlier is entered mid-way (its in-point advances) so a
 * playhead landing inside a clip sounds correct.
 *
 * A silent clip is still scheduled, with a gain of zero. That is deliberate:
 * muting or un-soloing a track while it plays has to become audible immediately,
 * and a clip that was never scheduled has no node to turn back up.
 */
export function scheduleClips(project, fromSec = 0) {
  const start = Math.max(0, Number(fromSec) || 0)
  const tracks = project?.tracks ?? []
  const anySolo = tracks.some((track) => track.solo)
  const out = []
  for (const track of tracks) {
    const trackGain = resolveTrackGain(track, anySolo)
    for (const item of track.items ?? []) {
      const length = Math.max(0, Number(item.outSec) - Number(item.inSec))
      if (!(length > 0)) continue
      const clipStart = Number(item.startSec) || 0
      if (clipStart + length <= start) continue

      const skipped = Math.max(0, start - clipStart)
      const duration = length - skipped
      if (!(duration > 0)) continue

      const itemGain = item.muted ? 0 : dbToGain(item.gainDb)
      out.push({
        itemId: item.id,
        trackId: track.id,
        material: item.material,
        when: Math.max(0, clipStart - start),
        duration,
        inSec: (Number(item.inSec) || 0) + skipped,
        // The two factors are kept apart as well as multiplied: the graph applies
        // them on separate nodes so a track fader never overwrites a clip fade.
        trackGain,
        itemGain,
        gain: trackGain * itemGain,
        pan: Math.max(-1, Math.min(1, (Number(item.pan) || 0) + (Number(track.pan) || 0))),
        // Fades are relative to the clip, so a clip entered mid-way keeps only
        // the part of its fade the playhead has not passed yet.
        fadeInSec: Math.max(0, (Number(item.fadeInSec) || 0) - skipped),
        fadeOutSec: Math.min(Number(item.fadeOutSec) || 0, duration),
      })
    }
  }
  return out.sort((a, b) => a.when - b.when || a.itemId.localeCompare(b.itemId))
}

/** How long the scheduled set lasts, in seconds. */
export function scheduledLength(entries) {
  let end = 0
  for (const entry of entries) end = Math.max(end, entry.when + entry.duration)
  return end
}

function materialUrl(root, projectId, materialId) {
  return `${API}/clipbay/media?root=${encodeURIComponent(root)}&project=${encodeURIComponent(projectId)}&id=${encodeURIComponent(materialId)}`
}

/** Decode once per material and keep it while the panel lives. */
function createBufferCache(context, root, projectId) {
  const buffers = new Map()
  const pending = new Map()
  return {
    get(materialId) {
      if (buffers.has(materialId)) return Promise.resolve(buffers.get(materialId))
      if (pending.has(materialId)) return pending.get(materialId)
      const request = fetch(materialUrl(root, projectId, materialId))
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.arrayBuffer()
        })
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => {
          buffers.set(materialId, buffer)
          pending.delete(materialId)
          return buffer
        })
        .catch((error) => {
          pending.delete(materialId)
          throw error
        })
      pending.set(materialId, request)
      return request
    },
  }
}

/** Transport for one project: play, pause, seek, and a sampled playhead. */
export function usePlayback(root, projectId) {
  const [playing, setPlaying] = useState(false)
  const [positionSec, setPositionSec] = useState(0)
  const [error, setError] = useState('')

  // One place moves the playhead, so the ref and the state cannot disagree.
  const setPositionEverywhere = useCallback((value) => {
    const next = Math.max(0, Number(value) || 0)
    lastPositionRef.current = next
    setPositionSec(next)
  }, [])

  const contextRef = useRef(null)
  const cacheRef = useRef(null)
  const sourcesRef = useRef([])
  const startedAtRef = useRef(0)
  const fromRef = useRef(0)
  const lastPositionRef = useRef(0)
  const frameRef = useRef(0)
  const projectRef = useRef(null)
  const tokenRef = useRef(0)

  const ensureContext = useCallback(() => {
    if (!contextRef.current) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext
      if (!Ctor) throw new Error('this browser has no WebAudio')
      contextRef.current = new Ctor()
      cacheRef.current = createBufferCache(contextRef.current, root, projectId)
    }
    return contextRef.current
  }, [root, projectId])

  const stopSources = useCallback(() => {
    for (const node of sourcesRef.current) {
      try { node.source.stop() } catch { /* already ended */ }
      for (const key of ['source', 'fade', 'itemLevel', 'trackLevel', 'panner']) {
        try { node[key]?.disconnect() } catch { /* already gone */ }
      }
    }
    sourcesRef.current = []
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
    }
  }, [])

  const pause = useCallback(() => {
    // Take the playhead from the last sampled frame, not by recomputing from the
    // clock: `stopSources` clears the anchor, and a recomputation that ran after
    // it would land on zero and lose where the user stopped.
    const at = lastPositionRef.current
    tokenRef.current++
    stopSources()
    startedAtRef.current = 0
    fromRef.current = at
    setPlaying(false)
    setPositionEverywhere(at)
  }, [setPositionEverywhere, stopSources])

  const seek = useCallback((seconds) => {
    const next = Math.max(0, Number(seconds) || 0)
    fromRef.current = next
    setPositionEverywhere(next)
  }, [setPositionEverywhere])

  const play = useCallback(async (fromSeconds) => {
    const project = projectRef.current
    if (!project) return
    let context
    try {
      context = ensureContext()
    } catch (caught) {
      setError(caught.message)
      return
    }
    if (context.state === 'suspended') await context.resume()

    const token = ++tokenRef.current
    stopSources()

    const start = Math.max(0, fromSeconds === undefined ? fromRef.current : Number(fromSeconds) || 0)
    const entries = scheduleClips(project, start)
    fromRef.current = start
    setPositionEverywhere(start)

    if (entries.length === 0) {
      setPlaying(false)
      return
    }

    startedAtRef.current = context.currentTime
    const master = context.createGain()
    master.gain.value = 1
    master.connect(context.destination)

    setError('')
    setPlaying(true)

    const nodes = []
    let failed = 0
    for (const entry of entries) {
      if (tokenRef.current !== token) return
      let buffer
      try {
        buffer = await cacheRef.current.get(entry.material)
      } catch {
        failed++
        continue
      }
      if (tokenRef.current !== token) return

      const source = context.createBufferSource()
      source.buffer = buffer

      // Three stages, so a live fader move and a running fade cannot overwrite
      // each other: the fade shapes `fade`, the clip gain sits on `itemLevel`,
      // and the track fader (mute/solo included) sits on `trackLevel`.
      const fade = context.createGain()
      const itemLevel = context.createGain()
      const trackLevel = context.createGain()
      itemLevel.gain.value = entry.itemGain
      trackLevel.gain.value = entry.trackGain

      const when = startedAtRef.current + entry.when
      const offset = Math.max(0, entry.inSec)
      const duration = Math.max(0, Math.min(entry.duration, buffer.duration - offset))
      if (!(duration > 0)) continue

      fade.gain.setValueAtTime(1, when)
      if (entry.fadeInSec > 0) {
        fade.gain.setValueAtTime(0, when)
        fade.gain.linearRampToValueAtTime(1, when + entry.fadeInSec)
      }
      if (entry.fadeOutSec > 0) {
        fade.gain.setValueAtTime(1, when + duration - entry.fadeOutSec)
        fade.gain.linearRampToValueAtTime(0, when + duration)
      }

      const panner = context.createStereoPanner ? context.createStereoPanner() : null
      source.connect(fade)
      fade.connect(itemLevel)
      itemLevel.connect(trackLevel)
      if (panner) {
        panner.pan.value = entry.pan
        trackLevel.connect(panner)
        panner.connect(master)
      } else {
        trackLevel.connect(master)
      }
      source.start(when, offset, duration)
      nodes.push({ source, fade, itemLevel, trackLevel, panner, trackId: entry.trackId, itemId: entry.itemId })
    }

    sourcesRef.current = nodes
    if (nodes.length === 0) {
      setPlaying(false)
      setError(failed > 0 ? 'no material could be decoded' : '')
      master.disconnect()
      return
    }

    const total = scheduledLength(entries)
    const tick = () => {
      if (tokenRef.current !== token) return
      const at = fromRef.current + (context.currentTime - startedAtRef.current)
      if (at >= fromRef.current + total) {
        stopSources()
        startedAtRef.current = 0
        fromRef.current = start + total
        setPlaying(false)
        setPositionEverywhere(start + total)
        master.disconnect()
        return
      }
      setPositionEverywhere(at)
      frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
  }, [ensureContext, setPositionEverywhere, stopSources])

  /**
   * Push the current mix onto the live graph.
   *
   * Called whenever the project changes, so dragging a fader or pressing mute
   * while the transport runs is heard at once instead of on the next play. The
   * ramp is short (about 30 ms) because a step change in gain clicks.
   *
   * Only the two gain stages are touched: the fade stage keeps whatever ramp it
   * is in the middle of, so a live fader move cannot cancel a fade.
   */
  const applyMix = useCallback((project) => {
    const context = contextRef.current
    if (!context || sourcesRef.current.length === 0) return
    const now = context.currentTime
    const tracks = project?.tracks ?? []
    const anySolo = tracks.some((entry) => entry.solo)
    for (const node of sourcesRef.current) {
      const track = tracks.find((entry) => entry.id === node.trackId)
      const item = track?.items?.find((entry) => entry.id === node.itemId)
      node.trackLevel?.gain.setTargetAtTime(resolveTrackGain(track, anySolo), now, TARGET_TAU_SEC)
      node.itemLevel?.gain.setTargetAtTime(item && !item.muted ? dbToGain(item.gainDb) : 0, now, TARGET_TAU_SEC)
    }
  }, [])

  const setProject = useCallback((project) => {
    projectRef.current = project
    // A live edit must be heard without a restart; a silent graph costs nothing.
    applyMix(project)
  }, [applyMix])

  useEffect(() => () => {
    tokenRef.current++
    stopSources()
    if (contextRef.current) {
      contextRef.current.close().catch(() => {})
      contextRef.current = null
    }
    cacheRef.current = null
  }, [stopSources])

  return { playing, positionSec, error, play, pause, seek, setProject, applyMix }
}
