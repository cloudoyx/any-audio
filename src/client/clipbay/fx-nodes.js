/**
 * The preview half of the effect chain (improvement plan 02, I-07).
 *
 * The two runtimes differ by necessity: the renderer walks arrays, the browser
 * builds nodes. What must not differ is the *number* each one uses, so every
 * parameter here comes from `resolveFx` in `src/audio/fx.js` — the same function
 * the renderer calls. Where a native node implements the same maths (a biquad is
 * a biquad, a compressor is a soft knee, a delay line is a delay line) the result
 * is the same filter, not an approximation of it.
 *
 * Two exceptions, both deliberate and both visible to the listener:
 *  - reverb runs `createReverbProcessor` inside an AudioWorklet, because the
 *    renderer uses Freeverb and no native node does Freeverb;
 *  - `pitch` is varispeed in both runtimes (the renderer's `preservePitch` adds a
 *    granular stretch that has no preview counterpart).
 */
import { createReverbProcessor, pitchFactor, resolveChain, resolveFx } from '../../audio/fx.js'

/** The worklet has to be added once per AudioContext, and only when needed. */
const workletState = new WeakMap()

function workletUrlFor(root) {
  return `${root}/reverb-worklet.js`
}

/**
 * Load the reverb processor for a context.
 *
 * A blob URL is not needed: the plugin ships the bundle and the page can fetch
 * it. A failure here must not take the transport down, so the caller gets `null`
 * and the preview keeps the dry signal — an audible, explainable difference is
 * better than a silent panel.
 */
export async function ensureReverbWorklet(context, cdns = []) {
  const cached = workletState.get(context)
  if (cached) return cached
  if (!context?.audioWorklet?.addModule) {
    workletState.set(context, null)
    return null
  }
  for (const url of cdns) {
    if (!url) continue
    try {
      await context.audioWorklet.addModule(url)
      workletState.set(context, true)
      return true
    } catch {
      // try the next candidate
    }
  }
  workletState.set(context, null)
  return null
}

/** True when a chain has something the native nodes cannot do. */
export function chainNeedsWorklet(chain) {
  return resolveChain(chain).some((fx) => fx.type === 'reverb')
}

function makeBiquad(context, band) {
  const node = context.createBiquadFilter()
  node.type = band.type === 'lowshelf' ? 'lowshelf' : band.type === 'highshelf' ? 'highshelf' : 'peaking'
  node.frequency.value = band.freqHz
  node.gain.value = band.gainDb
  if (node.type === 'peaking') node.Q.value = band.q
  return node
}

/**
 * One effect as a small node graph, with `input` and `output` already wired.
 *
 * `ctx` carries what an effect needs from outside itself: the sample rate, the
 * duck curve (computed by the caller from the sidechain track), and whether the
 * reverb worklet loaded.
 */
function buildEffect(context, fx, { hasWorklet = false } = {}) {
  const resolved = fx
  switch (fx.type) {
    case 'eq': {
      // One biquad per band, *always* — including a band sitting at 0 dB.
      //
      // Skipping flat bands looks like a free optimisation and is a trap: a chain
      // built from three flat bands then becomes a single pass-through gain, and
      // when the person turns one band up, `updateFxChain` sees "one node, one
      // audible band" and writes `.frequency` onto that gain node. That threw, the
      // render died, and the whole panel went blank — found by screenshotting the
      // panel after changing an EQ gain, not by any assertion.
      //
      // Building every band keeps the node count equal to the band count, which is
      // the invariant the live-update path relies on.
      const bands = resolved.bands
      if (bands.length === 0) return passthrough(context)
      const nodes = bands.map((band) => makeBiquad(context, band))
      return { ...chainOf(nodes), effectType: 'eq' }
    }
    case 'compressor': {
      const node = context.createDynamicsCompressor()
      node.threshold.value = resolved.thresholdDb
      node.ratio.value = resolved.ratio
      node.attack.value = resolved.attackSec
      node.release.value = resolved.releaseSec
      // DynamicsCompressorNode's knee is a width in dB, the same unit the renderer's
      // soft-knee curve uses.
      node.knee.value = resolved.kneeDb
      if (!resolved.makeupDb) return chainOf([node])
      const makeup = context.createGain()
      makeup.gain.value = 10 ** (resolved.makeupDb / 20)
      return chainOf([node, makeup])
    }
    case 'limiter': {
      const node = context.createDynamicsCompressor()
      // Fast, hard and predictable: the closest native shape to a ceiling.
      node.threshold.value = resolved.ceilingDb
      node.knee.value = 0
      node.ratio.value = 20
      node.attack.value = 0.001
      node.release.value = resolved.releaseSec
      return chainOf([node])
    }
    case 'delay': {
      const input = context.createGain()
      const output = context.createGain()
      const delay = context.createDelay(2)
      delay.delayTime.value = resolved.timeSec
      const feedback = context.createGain()
      feedback.gain.value = resolved.feedback
      const wet = context.createGain()
      wet.gain.value = resolved.wet
      const dry = context.createGain()
      dry.gain.value = resolved.dry
      input.connect(dry)
      dry.connect(output)
      input.connect(delay)
      delay.connect(wet)
      wet.connect(output)
      delay.connect(feedback)
      feedback.connect(delay)
      return { input, output, nodes: [input, output, delay, feedback, wet, dry], effectType: 'delay' }
    }
    case 'reverb': {
      if (!hasWorklet) return passthrough(context)
      const node = new AudioWorkletNode(context, 'anyaudio-reverb', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sampleRate: context.sampleRate, fx: resolved },
      })
      return { input: node, output: node, nodes: [node], effectType: 'reverb', worklet: node }
    }
    case 'duck': {
      const node = context.createGain()
      // The curve is scheduled when playback starts, because it is anchored to
      // absolute AudioContext time. `applyDuckCurve` below does that.
      return { input: node, output: node, nodes: [node], effectType: 'duck', duckGain: node }
    }
    case 'pitch':
      // Handled by the source node's playbackRate, which the transport sets when
      // it builds the clip; there is no separate node.
      return { input: null, output: null, nodes: [], effectType: 'pitch' }
    default:
      return passthrough(context)
  }
}

function passthrough(context) {
  const node = context.createGain()
  node.gain.value = 1
  return { input: node, output: node, nodes: [node] }
}

/** Wire a list of nodes in series and report the two ends. */
function chainOf(nodes) {
  for (let index = 0; index < nodes.length - 1; index++) nodes[index].connect(nodes[index + 1])
  return { input: nodes[0], output: nodes[nodes.length - 1], nodes }
}

/**
 * Build a whole chain.
 *
 * Returns the two endpoints plus the nodes to disconnect, and keeps the ducking
 * gain nodes so the caller can schedule their curves once the playhead position
 * is known.
 */
export function buildFxChain(context, chain, { hasWorklet = false } = {}) {
  const resolved = resolveChain(chain)
  if (resolved.length === 0) return null
  const built = []
  for (const fx of resolved) {
    built.push({ fx, ...buildEffect(context, fx, { hasWorklet }) })
  }
  // Effects that are pure gain (duck) or handled elsewhere (pitch) still need a
  // seam so the chain stays contiguous.
  const usable = built.filter((entry) => entry.input && entry.output)
  if (usable.length === 0) return null
  for (let index = 0; index < usable.length - 1; index++) {
    usable[index].output.connect(usable[index + 1].input)
  }
  const nodes = usable.flatMap((entry) => entry.nodes)
  return {
    input: usable[0].input,
    output: usable[usable.length - 1].output,
    nodes,
    effects: usable,
    effectTypes: usable.map((entry) => entry.effectType ?? entry.fx.type),
    pitchFx: built.find((entry) => entry.fx.type === 'pitch')?.fx ?? null,
    duckCurves: usable
      .filter((entry) => entry.duckGain)
      .map((entry) => ({ fx: entry.fx, gain: entry.duckGain })),
    dispose() {
      for (const node of nodes) {
        try { node.disconnect() } catch { /* already gone */ }
      }
    },
  }
}

/**
 * Push new parameter values onto an already-built chain.
 *
 * The transport keeps running, so a fader or an EQ gain moved mid-playback has to
 * be heard without rebuilding the graph (rebuilding would restart every clip and
 * drop the playhead's place). Only values are touched, never the shape: when a
 * type changes at a position the caller gets `false` and the change lands on the
 * next play, because inserting a node in the middle of a running graph would click.
 */
export function updateFxChain(built, chain) {
  if (!built) return true
  const wanted = resolveChain(chain)
  if (wanted.length !== built.effects.length) return false
  for (let index = 0; index < wanted.length; index++) {
    const fx = wanted[index]
    const entry = built.effects[index]
    const currentType = entry.effectType ?? entry.fx.type
    if (currentType !== fx.type) return false
    switch (fx.type) {
      case 'eq': {
        // One node per band, both here and in `buildEffect`: the counts match by
        // construction, so a band turning from 0 dB to +18 dB only writes values
        // onto nodes that already exist. Filtering flat bands on either side is
        // what made this branch throw and blank the panel.
        const bands = entry.nodes
        if (bands.length !== fx.bands.length) return false
        for (let b = 0; b < bands.length; b++) {
          const wanted = fx.bands[b]
          const node = bands[b]
          node.frequency.value = wanted.freqHz
          node.gain.value = wanted.gainDb
          if (node.type === 'peaking') node.Q.value = wanted.q
        }
        break
      }
      case 'compressor': {
        const node = entry.nodes[0]
        node.threshold.value = fx.thresholdDb
        node.ratio.value = fx.ratio
        node.attack.value = fx.attackSec
        node.release.value = fx.releaseSec
        node.knee.value = fx.kneeDb
        if (entry.nodes[1]) entry.nodes[1].gain.value = 10 ** (fx.makeupDb / 20)
        break
      }
      case 'limiter': {
        const node = entry.nodes[0]
        node.threshold.value = fx.ceilingDb
        node.release.value = fx.releaseSec
        break
      }
      case 'delay': {
        const [input, output, delay, feedback, wet, dry] = entry.nodes
        void input
        void output
        delay.delayTime.value = fx.timeSec
        feedback.gain.value = fx.feedback
        wet.gain.value = fx.wet
        dry.gain.value = fx.dry
        break
      }
      case 'reverb':
        entry.worklet?.port.postMessage({ type: 'params', fx })
        break
      case 'duck':
        // The curve is re-scheduled by the caller, which owns the envelope.
        entry.duckGain = entry.duckGain ?? null
        break
      default:
        break
    }
  }
  return true
}

/**
 * Schedule one ducking curve onto its gain node.
 *
 * `curve` covers the whole project from t=0 at `pointsPerSecond`; playback starts
 * at `fromSec`, so the value curve is scheduled for the part that is still ahead.
 * `setValueCurveAtTime` interpolates between points, which is why 200 points per
 * second is plenty for a several-second envelope.
 */
export function applyDuckCurve(gainNode, curve, { fromSec, when, durationSec, pointsPerSecond }) {
  if (!gainNode || !curve || curve.length === 0) return
  const start = Math.max(0, Math.floor(fromSec * pointsPerSecond))
  const count = Math.max(2, Math.min(curve.length - start, Math.ceil(durationSec * pointsPerSecond)))
  if (count <= 1) return
  const slice = curve.subarray(start, start + count)
  const span = count / pointsPerSecond
  gainNode.gain.setValueCurveAtTime(slice, when, span)
}

/** How much faster the clip is consumed, from the chain's pitch effect. */
export function chainPlaybackRate(chain) {
  const fx = resolveChain(chain).find((entry) => entry.type === 'pitch')
  return fx ? pitchFactor(resolveFx(fx)) : 1
}
