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

/**
 * Build the clips to schedule. Pure, so the numbers can be checked without an
 * AudioContext.
 *
 * `fromSec` is where playback begins; a clip that already ended is dropped, and
 * one that started earlier is entered mid-way (its in-point advances) so a
 * playhead landing inside a clip sounds correct.
 */
export function scheduleClips(project, fromSec = 0) {
  const start = Math.max(0, Number(fromSec) || 0)
  const out = []
  for (const track of audibleTracks(project?.tracks)) {
    const trackGain = dbToGain(track.volumeDb)
    for (const item of track.items ?? []) {
      if (item.muted) continue
      const length = Math.max(0, Number(item.outSec) - Number(item.inSec))
      if (!(length > 0)) continue
      const clipStart = Number(item.startSec) || 0
      if (clipStart + length <= start) continue

      const skipped = Math.max(0, start - clipStart)
      const duration = length - skipped
      if (!(duration > 0)) continue

      out.push({
        itemId: item.id,
        trackId: track.id,
        material: item.material,
        when: Math.max(0, clipStart - start),
        duration,
        inSec: (Number(item.inSec) || 0) + skipped,
        gain: trackGain * dbToGain(item.gainDb),
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
      node.source.disconnect()
      node.level.disconnect()
      if (node.panner) node.panner.disconnect()
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
      const level = context.createGain()
      const peak = entry.gain
      level.gain.value = peak

      const when = startedAtRef.current + entry.when
      const offset = Math.max(0, entry.inSec)
      const duration = Math.max(0, Math.min(entry.duration, buffer.duration - offset))
      if (!(duration > 0)) continue

      if (entry.fadeInSec > 0) {
        level.gain.setValueAtTime(0, when)
        level.gain.linearRampToValueAtTime(peak, when + entry.fadeInSec)
      }
      if (entry.fadeOutSec > 0) {
        level.gain.setValueAtTime(peak, when + duration - entry.fadeOutSec)
        level.gain.linearRampToValueAtTime(0, when + duration)
      }

      const panner = context.createStereoPanner ? context.createStereoPanner() : null
      source.connect(level)
      if (panner) {
        panner.pan.value = entry.pan
        level.connect(panner)
        panner.connect(master)
      } else {
        level.connect(master)
      }
      source.start(when, offset, duration)
      nodes.push({ source, level, panner })
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

  const setProject = useCallback((project) => {
    projectRef.current = project
  }, [])

  useEffect(() => () => {
    tokenRef.current++
    stopSources()
    if (contextRef.current) {
      contextRef.current.close().catch(() => {})
      contextRef.current = null
    }
    cacheRef.current = null
  }, [stopSources])

  return { playing, positionSec, error, play, pause, seek, setProject }
}
