/**
 * The preview's node graph (improvement plan 02, I-07) — driven without a browser.
 *
 * Two defects found by screenshotting the real panel live here as assertions, and
 * neither was reachable from the renderer's tests or from a static source check:
 *
 *  ① `buildEffect` was called with one argument while it read `fx.type` off its
 *    second, so *any* project with a chain threw on play. The transport went
 *    silent and the panel looked frozen; the error only appeared as an unhandled
 *    rejection in the page.
 *  ② The EQ built one node per *audible* band, so a chain of flat bands was a
 *    single pass-through gain. Turning a band from 0 dB to +18 dB then made
 *    `updateFxChain` write `.frequency` onto that gain node, which threw and took
 *    the whole React tree down — a blank panel.
 *
 * A fake AudioContext is enough to catch both, and it catches them at the layer
 * that broke rather than through the UI. Every node records what was written to
 * it, so the tests can assert on parameters as well as on survival.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// `fx-nodes.js` imports `fx.js` for the shared parameters. The data: URL loader
// resolves no imports, so the dependency is concatenated in front — the same
// module the browser bundle inlines.
const fxSource = readFileSync(join(root, 'src', 'audio', 'fx.js'), 'utf8')
const nodesSource = readFileSync(join(root, 'src', 'client', 'clipbay', 'fx-nodes.js'), 'utf8')
  .replace(/^import .*$/gm, '')

// --- a minimal WebAudio ------------------------------------------------------
//
// Only what `fx-nodes.js` touches. A param records every write so a test can say
// "the ceiling was set to -3" instead of "a node existed".

function makeParam(value = 0) {
  return {
    value,
    setTargetAtTime(target) { this.value = target },
    setValueAtTime(target) { this.value = target },
    setValueCurveAtTime() { throw new Error('the preview should not schedule duck curves here') },
  }
}

function makeNode(type) {
  const connections = []
  return {
    kind: type,
    connections,
    connect(target) { connections.push(target); return target },
    disconnect() { connections.length = 0 },
  }
}

function makeContext() {
  const created = []
  const context = {
    sampleRate: 48000,
    created,
    createGain() {
      const node = { ...makeNode('gain'), gain: makeParam(1) }
      created.push(node)
      return node
    },
    createBiquadFilter() {
      const node = { ...makeNode('biquad'), type: 'peaking', frequency: makeParam(350), Q: makeParam(1), gain: makeParam(0) }
      created.push(node)
      return node
    },
    createDynamicsCompressor() {
      const node = {
        ...makeNode('compressor'),
        threshold: makeParam(-24), knee: makeParam(30), ratio: makeParam(12),
        attack: makeParam(0.003), release: makeParam(0.25),
      }
      created.push(node)
      return node
    },
    createDelay() {
      const node = { ...makeNode('delay'), delayTime: makeParam(0) }
      created.push(node)
      return node
    },
  }
  return context
}

// `AudioWorkletNode` is a global in the browser; the reverb branch constructs one.
const workletNodes = []
class FakeWorkletNode {
  constructor(context, name, options) {
    this.kind = 'worklet'
    this.name = name
    this.options = options
    this.connections = []
    this.messages = []
    this.port = { postMessage: (message) => this.messages.push(message) }
    this.connect = (target) => { this.connections.push(target); return target }
    this.disconnect = () => { this.connections.length = 0 }
    workletNodes.push(this)
  }
}
globalThis.AudioWorkletNode = FakeWorkletNode

const { buildFxChain, updateFxChain, chainPlaybackRate } = await import(
  `data:text/javascript;base64,${Buffer.from(`${fxSource}\n${nodesSource}`, 'utf8').toString('base64')}`
)

let passed = 0
let failed = 0
function test(name, run) {
  try {
    run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- building a chain --------------------------------------------------------

test('every effect type builds without throwing', () => {
  // The defect this pins: `buildEffect` was handed one argument and read `fx.type`
  // off nothing, so building *any* chain threw. A loop over all seven is the
  // cheapest way to keep that from coming back.
  const context = makeContext()
  const types = ['eq', 'compressor', 'limiter', 'reverb', 'delay', 'duck', 'pitch']
  for (const type of types) {
    assert.doesNotThrow(
      () => buildFxChain(context, [{ type }], { hasWorklet: true }),
      `building a "${type}" chain must not throw`,
    )
  }
})

test('a chain with no effects returns null instead of an empty graph', () => {
  const context = makeContext()
  assert.equal(buildFxChain(context, []), null)
  assert.equal(buildFxChain(context, undefined), null)
})

test('the chain is wired input → each effect → output', () => {
  const context = makeContext()
  const built = buildFxChain(context, [
    { type: 'eq', bands: [{ type: 'peaking', freqHz: 220, gainDb: 3, q: 1 }] },
    { type: 'compressor', thresholdDb: -18, ratio: 3 },
    { type: 'delay', timeSec: 0.2, wet: 0.3 },
  ], { hasWorklet: true })
  assert.ok(built, 'a three-effect chain builds')
  assert.deepEqual(built.effectTypes, ['eq', 'compressor', 'delay'])
  // Walking the connections from the input has to reach the output.
  let node = built.input
  const seen = new Set()
  while (node && node !== built.output) {
    assert.ok(!seen.has(node), 'the graph must not contain a cycle')
    seen.add(node)
    node = node.connections[0]
  }
  assert.equal(node, built.output, 'the input reaches the output through the chain')
})

test('the EQ builds one node per band, flat bands included', () => {
  // The defect this pins: flat bands were filtered out, so a chain of them was one
  // pass-through gain, and `updateFxChain` later wrote `.frequency` onto it.
  const context = makeContext()
  const built = buildFxChain(context, [{
    type: 'eq',
    bands: [
      { type: 'peaking', freqHz: 220, gainDb: 0, q: 1 },
      { type: 'peaking', freqHz: 1000, gainDb: 0, q: 1 },
      { type: 'highshelf', freqHz: 8000, gainDb: 0, q: 1 },
    ],
  }])
  assert.ok(built, 'a flat EQ still builds')
  assert.equal(built.effects[0].nodes.length, 3, 'three bands means three biquads, whatever their gain')
  assert.equal(built.nodes.filter((node) => node.kind === 'biquad').length, 3)
})

test('a flat EQ is a pass-through in value, not in shape', () => {
  const context = makeContext()
  const built = buildFxChain(context, [{
    type: 'eq',
    bands: [{ type: 'peaking', freqHz: 1000, gainDb: 0, q: 1 }],
  }])
  assert.equal(built.effects[0].nodes[0].gain.value, 0, '0 dB is written as 0 dB')
})

// --- live updates -----------------------------------------------------------

test('turning a flat EQ band up updates the existing node', () => {
  // The exact sequence that blanked the panel: build at 0 dB, then set +18 dB.
  const context = makeContext()
  const chain = [{ type: 'eq', bands: [{ type: 'peaking', freqHz: 220, gainDb: 0, q: 1 }] }]
  const built = buildFxChain(context, chain)
  const updated = updateFxChain(built, [{ type: 'eq', bands: [{ type: 'peaking', freqHz: 220, gainDb: 18, q: 1 }] }])
  assert.equal(updated, true, 'the update is applied in place')
  const node = built.effects[0].nodes[0]
  assert.equal(node.kind, 'biquad', 'the node is still a biquad, not the old pass-through gain')
  assert.equal(node.gain.value, 18, 'and it carries the new gain')
})

test('an EQ whose band count changes is refused, not applied half-way', () => {
  const context = makeContext()
  const built = buildFxChain(context, [{ type: 'eq', bands: [{ type: 'peaking', freqHz: 220, gainDb: 0, q: 1 }] }])
  const updated = updateFxChain(built, [{
    type: 'eq',
    bands: [{ type: 'peaking', freqHz: 220, gainDb: 0, q: 1 }, { type: 'peaking', freqHz: 900, gainDb: 0, q: 1 }],
  }])
  assert.equal(updated, false, 'adding a band needs a rebuild, so the caller is told to rebuild')
})

test('a type change at a position is refused rather than spliced into a live graph', () => {
  const context = makeContext()
  const built = buildFxChain(context, [{ type: 'compressor', thresholdDb: -18, ratio: 3 }])
  assert.equal(updateFxChain(built, [{ type: 'limiter', ceilingDb: -3 }]), false)
  assert.equal(updateFxChain(built, []), false, 'removing an effect needs a rebuild too')
})

test('compressor, limiter and delay parameters reach their nodes', () => {
  const context = makeContext()

  const compressor = buildFxChain(context, [{ type: 'compressor', thresholdDb: -18, ratio: 4, attackSec: 0.01, releaseSec: 0.2, kneeDb: 6 }])
  const comp = compressor.effects[0].nodes[0]
  assert.equal(comp.kind, 'compressor')
  assert.equal(comp.threshold.value, -18)
  assert.equal(comp.ratio.value, 4)
  assert.equal(comp.knee.value, 6)

  const limiter = buildFxChain(context, [{ type: 'limiter', ceilingDb: -3, releaseSec: 0.1 }])
  const lim = limiter.effects[0].nodes[0]
  assert.equal(lim.threshold.value, -3, 'the ceiling is the threshold')
  assert.equal(lim.knee.value, 0, 'and the knee is flat')
  assert.equal(lim.ratio.value, 20, 'with a ratio steep enough to act as a ceiling')

  const delay = buildFxChain(context, [{ type: 'delay', timeSec: 0.25, feedback: 0.4, wet: 0.3, dry: 0.9 }])
  const nodes = delay.effects[0].nodes
  assert.equal(nodes.find((node) => node.kind === 'delay').delayTime.value, 0.25, 'the delay time is set')
})

test('a makeup gain is added only when it is not zero', () => {
  const context = makeContext()
  const plain = buildFxChain(context, [{ type: 'compressor', thresholdDb: -18, ratio: 3, makeupDb: 0 }])
  assert.equal(plain.effects[0].nodes.length, 1, 'no makeup means no extra gain node')
  const lifted = buildFxChain(context, [{ type: 'compressor', thresholdDb: -18, ratio: 3, makeupDb: 6 }])
  assert.equal(lifted.effects[0].nodes.length, 2, 'makeup adds one')
  const gainNode = lifted.effects[0].nodes[1]
  assert.ok(Math.abs(gainNode.gain.value - 1.9952623149688795) < 1e-9, '+6 dB is about 2.0 linear')
})

test('reverb uses the worklet when it is available and passes through when not', () => {
  workletNodes.length = 0
  const context = makeContext()

  const withWorklet = buildFxChain(context, [{ type: 'reverb', wet: 0.5 }], { hasWorklet: true })
  assert.equal(withWorklet.effects[0].effectType, 'reverb')
  assert.equal(workletNodes.length, 1, 'one worklet node is constructed')
  assert.equal(workletNodes[0].name, 'anyaudio-reverb')
  assert.equal(workletNodes[0].options.processorOptions.fx.wet, 0.5, 'the parameters travel with it')

  // Without the worklet the preview keeps the dry signal rather than failing.
  const without = buildFxChain(context, [{ type: 'reverb', wet: 0.5 }], { hasWorklet: false })
  assert.equal(without.effects[0].nodes.length, 1)
  assert.equal(without.effects[0].nodes[0].kind, 'gain', 'the fallback is a pass-through')
})

test('a reverb parameter change is posted to the running worklet', () => {
  workletNodes.length = 0
  const context = makeContext()
  const built = buildFxChain(context, [{ type: 'reverb', wet: 0.2 }], { hasWorklet: true })
  const node = workletNodes[0]
  assert.equal(updateFxChain(built, [{ type: 'reverb', wet: 0.8 }]), true)
  assert.equal(node.messages.length, 1, 'the change was sent')
  assert.equal(node.messages[0].type, 'params')
  assert.equal(node.messages[0].fx.wet, 0.8)
})

test('ducking exposes the gain node its curve is scheduled on', () => {
  const context = makeContext()
  const built = buildFxChain(context, [{ type: 'duck', sourceTrackId: 'trk_voice', targetDb: -12 }])
  assert.equal(built.duckCurves.length, 1, 'the caller gets one curve slot')
  assert.equal(built.duckCurves[0].fx.sourceTrackId, 'trk_voice')
  assert.equal(built.duckCurves[0].gain.kind, 'gain', 'scheduled on a gain node')
})

test('pitch is not a node: it is the source playback rate', () => {
  const context = makeContext()
  const built = buildFxChain(context, [{ type: 'pitch', pitchSemitones: 12 }])
  // A chain of only a pitch effect has nothing to wire, so the caller gets null and
  // reads the rate separately.
  assert.equal(built, null, 'a pitch-only chain needs no nodes')
  assert.ok(Math.abs(chainPlaybackRate([{ type: 'pitch', pitchSemitones: 12 }]) - 2) < 1e-9, 'an octave is 2×')
  assert.equal(chainPlaybackRate([]), 1)
  assert.equal(chainPlaybackRate(undefined), 1)
})

test('dispose disconnects every node it created', () => {
  const context = makeContext()
  const built = buildFxChain(context, [
    { type: 'eq', bands: [{ type: 'peaking', freqHz: 220, gainDb: 3, q: 1 }] },
    { type: 'delay', timeSec: 0.2 },
  ])
  built.dispose()
  for (const node of built.nodes) assert.equal(node.connections.length, 0, `${node.kind} was left connected`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
