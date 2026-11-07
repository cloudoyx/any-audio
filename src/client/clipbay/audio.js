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
import { buildDuckCurve } from '../../audio/fx.js'
import { fadeCurve, itemParams, masterParams, panGains, resolveTrackGain } from './mix-params.js'
import { buildFxChain, chainPlaybackRate, ensureReverbWorklet, updateFxChain } from './fx-nodes.js'

/**
 * Resolution of a ducking curve in the preview: 50 points a second.
 *
 * The renderer walks its envelope sample by sample; the preview schedules a
 * `setValueCurveAtTime` and lets the node interpolate. At 20 ms per point the
 * difference is far below what an ear resolves on a several-second envelope, and
 * a fifteen-minute project costs 45k floats instead of 43M.
 */
const DUCK_POINTS_PER_SEC = 50

/**
 * Where the reverb worklet bundle lives on the host.
 *
 * It cannot go inside the main bundle — a worklet is fetched by URL and runs on
 * the audio thread — so the build writes it as a second entry point and the host
 * serves it from `/clipbay/worklet`. Same origin, so `addModule` needs no CORS.
 */
const WORKLET_URL = `${API}/clipbay/worklet`

/**
 * The sidechain *envelope* — not a finished curve — for ducking.
 *
 * The parameters of a duck (target, threshold, attack, release) live on the
 * effect, not on the track, so the envelope is measured once per source track and
 * each duck turns it into a curve with its own numbers. Returning a curve here
 * would have meant one source track could only ever have one duck.
 *
 * The renderer sums that track's clips and runs `monoEnvelope` sample by sample;
 * this does the same thing coarser (DUCK_POINTS_PER_SEC). What the ear reads is
 * "the voice is present here", not the sample-accurate shape of the envelope.
 */
async function sidechainEnvelope(project, trackId, cache) {
  const track = (project?.tracks ?? []).find((entry) => entry.id === trackId)
  if (!track) return null
  let end = 0
  const clips = []
  for (const item of track.items ?? []) {
    if (item.muted) continue
    const lengthSec = Math.max(0, Number(item.outSec) - Number(item.inSec))
    if (!(lengthSec > 0)) continue
    clips.push({ item, lengthSec })
    end = Math.max(end, Number(item.startSec) + lengthSec)
  }
  if (clips.length === 0 || !(end > 0)) return null
  const points = Math.max(2, Math.ceil(end * DUCK_POINTS_PER_SEC))
  const envelope = new Float32Array(points)
  for (const { item, lengthSec } of clips) {
    let buffer
    try {
      buffer = await cache.get(item.material)
    } catch {
      continue
    }
    const startPoint = Math.max(0, Math.floor((Number(item.startSec) || 0) * DUCK_POINTS_PER_SEC))
    const inFrames = Math.max(0, Math.round((Number(item.inSec) || 0) * buffer.sampleRate))
    const limit = Math.min(buffer.length, inFrames + Math.round(lengthSec * buffer.sampleRate))
    const step = Math.max(1, Math.round(buffer.sampleRate / DUCK_POINTS_PER_SEC))
    const channels = []
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) channels.push(buffer.getChannelData(channel))
    for (let point = 0; startPoint + point < points; point++) {
      const from = inFrames + point * step
      if (from >= limit) break
      const to = Math.min(limit, from + step)
      let peak = 0
      for (const data of channels) {
        for (let i = from; i < to; i++) {
          const value = Math.abs(data[i])
          if (value > peak) peak = value
        }
      }
      if (peak > envelope[startPoint + point]) envelope[startPoint + point] = peak
    }
  }
  return envelope
}

/** Time constant for a live gain move: short enough to feel immediate, long
 * enough that a step does not click. `setTargetAtTime` reaches ~95% in 3τ. */
export const TARGET_TAU_SEC = 0.01

/**
 * Points per second for a scheduled fade curve.
 *
 * The renderer walks its fade frame by frame; the preview hands WebAudio a
 * curve and the node interpolates between the points. 200 points per second is
 * 5 ms, far below the ear's resolution for a gain ramp, and a two-second fade
 * costs 400 floats.
 */
const FADE_CURVE_POINTS_PER_SEC = 200

/**
 * Shape a clip's fades onto one gain node, using the renderer's own curve.
 *
 * Three segments rather than one curve over the whole clip keeps the point count
 * proportional to the fade, not to the clip: a two-second fade on a ten-minute
 * clip would otherwise get a handful of points and audibly step.
 */
function scheduleFades(gain, when, duration, fadeInSec, fadeOutSec) {
  gain.setValueAtTime(1, when)
  const total = Math.max(0, Number(duration) || 0)
  const fadeIn = Math.max(0, Math.min(Number(fadeInSec) || 0, total))
  const fadeOut = Math.max(0, Math.min(Number(fadeOutSec) || 0, total - fadeIn))
  if (fadeIn > 0) {
    const points = Math.max(2, Math.round(fadeIn * FADE_CURVE_POINTS_PER_SEC))
    gain.setValueCurveAtTime(fadeCurve(points, points / fadeIn, fadeIn, 0), when, fadeIn)
  }
  if (fadeOut > 0) {
    const points = Math.max(2, Math.round(fadeOut * FADE_CURVE_POINTS_PER_SEC))
    gain.setValueCurveAtTime(fadeCurve(points, points / fadeOut, 0, fadeOut), when + total - fadeOut, fadeOut)
  }
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
  return resolveTrackGain(track, anySolo) * itemParams(item, track).gain
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

      const params = itemParams(item, track)
      const itemGain = item.muted ? 0 : params.gain
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
        pan: params.pan,
        // Fades are relative to the clip, so a clip entered mid-way keeps only
        // the part of its fade the playhead has not passed yet.
        fadeInSec: Math.max(0, params.fadeInSec - skipped),
        fadeOutSec: Math.min(params.fadeOutSec, duration),
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
  const masterRef = useRef(null)
  // The bus chain and the per-track buses outlive the clips: a live fader or EQ
  // move has to reach nodes that belong to the track, not to one clip on it.
  const masterChainRef = useRef(null)
  const busesRef = useRef([])
  const hasWorkletRef = useRef(false)
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
      for (const key of ['source', 'fade', 'itemLevel', 'splitter', 'panLeft', 'panRight', 'merger']) {
        try { node[key]?.disconnect() } catch { /* already gone */ }
      }
      node.clipChain?.dispose()
    }
    sourcesRef.current = []
    for (const bus of busesRef.current) {
      try { bus.fader.disconnect() } catch { /* already gone */ }
      bus.chain?.dispose()
    }
    busesRef.current = []
    masterChainRef.current?.dispose()
    masterChainRef.current = null
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
    // The master is the frozen normalisation plus the person's fader, exactly as
    // the renderer applies it (spec §10.2). Hard-coding 1 here was why a bus
    // fader move was audible nowhere until the export came out different.
    master.gain.value = masterParams(project).gain
    masterRef.current = master

    // Effects need the reverb worklet, and loading it is async: do it once, up
    // front, so the graph is built in one synchronous pass below.
    const anyFx = Boolean(project.masterFx?.length)
      || project.tracks.some((track) => track.fx?.length || (track.items ?? []).some((item) => item.fx?.length))
    const hasWorklet = anyFx ? Boolean(await ensureReverbWorklet(context, [WORKLET_URL])) : false
    if (tokenRef.current !== token) return

    // Same order as the renderer: master gain first, then the bus chain.
    hasWorkletRef.current = hasWorklet
    const masterChain = buildFxChain(context, project.masterFx, { hasWorklet })
    masterChainRef.current = masterChain
    if (masterChain) {
      master.connect(masterChain.input)
      masterChain.output.connect(context.destination)
    } else {
      master.connect(context.destination)
    }

    // Ducking reads another track's level, so those envelopes have to exist
    // before any chain is scheduled.
    const sidechainEnvelopes = new Map()
    const loadDuckEnvelope = async (trackId) => {
      if (sidechainEnvelopes.has(trackId)) return sidechainEnvelopes.get(trackId)
      const envelope = await sidechainEnvelope(project, trackId, cacheRef.current)
      sidechainEnvelopes.set(trackId, envelope)
      return envelope
    }
    const duckSources = new Set()
    for (const chain of [project.masterFx, ...project.tracks.flatMap((track) => [track.fx, ...(track.items ?? []).map((item) => item.fx)])]) {
      for (const fx of chain ?? []) if (fx?.type === 'duck' && fx.sourceTrackId) duckSources.add(fx.sourceTrackId)
    }
    for (const trackId of duckSources) await loadDuckEnvelope(trackId)
    if (tokenRef.current !== token) return

    const when = startedAtRef.current
    const total = scheduledLength(entries)
    /**
     * Schedule every ducking curve of one built chain.
     *
     * Each duck turns the shared envelope into a curve with *its own* parameters:
     * a track ducking at −6 dB and a bus ducking at −12 dB can read the same
     * narration track and must still behave differently.
     */
    const scheduleDucks = (built) => {
      if (!built) return
      for (const { fx, gain } of built.duckCurves) {
        const envelope = sidechainEnvelopes.get(fx.sourceTrackId)
        if (!envelope) continue
        const curve = buildDuckCurve(envelope, DUCK_POINTS_PER_SEC, fx)
        applyDuckCurve(gain, curve, {
          fromSec: start,
          when,
          durationSec: total,
          pointsPerSecond: DUCK_POINTS_PER_SEC,
        })
      }
    }

    // One bus per track, shared by its clips: clips sum into the bus first, then
    // the track chain, then the fader — the order the renderer uses.
    const trackBuses = new Map()
    const ensureTrackBus = (trackId) => {
      if (trackBuses.has(trackId)) return trackBuses.get(trackId)
      const track = project.tracks.find((entry) => entry.id === trackId)
      const fader = context.createGain()
      fader.gain.value = resolveTrackGain(track, project.tracks.some((entry) => entry.solo))
      const chain = buildFxChain(context, track?.fx, { hasWorklet })
      const tail = chain ? chain.output : fader
      if (chain) fader.connect(chain.input)
      tail.connect(master)
      scheduleDucks(chain)
      const bus = { trackId, fader, chain }
      trackBuses.set(trackId, bus)
      busesRef.current.push(bus)
      return bus
    }

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
      // and the track fader (mute/solo included) sits on the bus.
      const fade = context.createGain()
      const itemLevel = context.createGain()
      itemLevel.gain.value = entry.itemGain

      const clipStart = startedAtRef.current + entry.when
      const offset = Math.max(0, entry.inSec)
      const duration = Math.max(0, Math.min(entry.duration, buffer.duration - offset))
      if (!(duration > 0)) continue

      // Same cosine curve the renderer applies, scheduled as a value curve.
      scheduleFades(fade.gain, clipStart, duration, entry.fadeInSec, entry.fadeOutSec)

      // Pan by hand, not with StereoPannerNode: that node gives 0.707 per side at
      // centre, while the renderer's law is a true bypass (1, 1) at centre — a
      // 3 dB disagreement on every centred clip, measured, not guessed. Splitting
      // and re-gaining reproduces the renderer's pair exactly.
      const splitter = context.createChannelSplitter(2)
      const merger = context.createChannelMerger(2)
      const panLeft = context.createGain()
      const panRight = context.createGain()
      const [gainLeft, gainRight] = panGains(entry.pan)
      panLeft.gain.value = gainLeft
      panRight.gain.value = gainRight

      const item = project.tracks.find((track) => track.id === entry.trackId)
        ?.items?.find((candidate) => candidate.id === entry.itemId)
      const clipChain = buildFxChain(context, item?.fx, { hasWorklet })
      scheduleDucks(clipChain)

      const bus = ensureTrackBus(entry.trackId)
      source.connect(fade)
      fade.connect(itemLevel)
      const head = clipChain ? clipChain.input : null
      const tail = clipChain ? clipChain.output : null
      if (head) itemLevel.connect(head)
      else itemLevel.connect(splitter)
      if (tail) tail.connect(splitter)
      splitter.connect(panLeft, 0)
      splitter.connect(panRight, 1)
      panLeft.connect(merger, 0, 0)
      panRight.connect(merger, 0, 1)
      merger.connect(bus.fader)

      // A pitch effect is varispeed in both runtimes: `start`'s duration is in
      // buffer time, so the clip still occupies its place on the timeline.
      const rate = chainPlaybackRate(item?.fx)
      if (rate !== 1) source.playbackRate.value = rate

      source.start(clipStart, offset, duration)
      nodes.push({
        source, fade, itemLevel, splitter, merger, panLeft, panRight,
        trackId: entry.trackId, itemId: entry.itemId, clipChain,
      })
    }

    sourcesRef.current = nodes
    if (nodes.length === 0) {
      setPlaying(false)
      setError(failed > 0 ? 'no material could be decoded' : '')
      master.disconnect()
      return
    }

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
   * Only the three level stages are touched: the fade stage keeps whatever ramp
   * it is in the middle of, so a live fader move cannot cancel a fade.
   *
   * Pan is pushed here too, and it has to be: the panner is built once when
   * playback starts, so without this a pan move made while the transport runs
   * was never heard until the next play.
   */
  const applyMix = useCallback((project) => {
    const context = contextRef.current
    if (!context) return
    const now = context.currentTime
    const tracks = project?.tracks ?? []
    const anySolo = tracks.some((entry) => entry.solo)
    // The bus gain is pushed even when nothing is scheduled: the person can move
    // the master fader before pressing play, and the next play reads it anyway,
    // but keeping one place that writes it means the two can never disagree.
    masterRef.current?.gain.setTargetAtTime(masterParams(project).gain, now, TARGET_TAU_SEC)
    // The bus chain's own parameters move too: turning an EQ gain or a limiter
    // ceiling while the transport runs has to be heard, or the panel is lying.
    if (masterChainRef.current) updateFxChain(masterChainRef.current, project?.masterFx)
    // A track's fader lives on its bus now, not on each clip, so it is pushed
    // once per track rather than once per scheduled clip.
    for (const bus of busesRef.current) {
      const track = tracks.find((entry) => entry.id === bus.trackId)
      bus.fader.gain.setTargetAtTime(resolveTrackGain(track, anySolo), now, TARGET_TAU_SEC)
      if (bus.chain) updateFxChain(bus.chain, track?.fx)
    }
    if (sourcesRef.current.length === 0) return
    for (const node of sourcesRef.current) {
      const track = tracks.find((entry) => entry.id === node.trackId)
      const item = track?.items?.find((entry) => entry.id === node.itemId)
      const params = itemParams(item, track)
      node.itemLevel?.gain.setTargetAtTime(item && !item.muted ? params.gain : 0, now, TARGET_TAU_SEC)
      // Pan moves ramp on the same path as the faders, on the two gains the
      // renderer's law produces.
      const [gainLeft, gainRight] = panGains(params.pan)
      node.panLeft?.gain.setTargetAtTime(gainLeft, now, TARGET_TAU_SEC)
      node.panRight?.gain.setTargetAtTime(gainRight, now, TARGET_TAU_SEC)
      if (node.clipChain) updateFxChain(node.clipChain, item?.fx)
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
