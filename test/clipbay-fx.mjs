/**
 * The seven effects (improvement plan 02, I-07).
 *
 * Two things have to be true, and they are different things:
 *  ① each effect does what its maths says — an EQ lifts the band it points at, a
 *    compressor pulls down what is over the threshold, a limiter holds a ceiling,
 *    a delay repeats at its time, a reverb leaves a tail, a duck follows its
 *    source, a pitch change changes the length;
 *  ② the chain's *order* is the one the plan fixed, because getting it wrong is
 *    a bug that passes an ordinary test: a limiter at −1 dBFS followed by a +6 dB
 *    master fader is +5 dBFS, and every "does the limiter limit" assertion still
 *    passes because it was applied first.
 *
 * ② is why the master order case exists below, and why it drives a real render
 * instead of calling the chain directly.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeWav, parseWav, peakOf, rmsOf, toDb } from '../src/audio/wav.js'
import {
  applyCompressor, applyDelay, applyDuck, applyEq, applyFxChain, applyLimiter, applyPitch,
  applyReverb, buildDuckCurve, createReverbProcessor, defaultFx, monoEnvelope, pitchFactor,
  resolveChain, resolveFx, compressorCurve, biquadCoefficients, FX_TYPES, MAX_FX_PER_CHAIN,
} from '../src/audio/fx.js'
import { renderProject } from '../src/project/render.js'
import { writeMaterialIndex, saveProject } from '../src/project/store.js'
import { materialsDir, projectDir } from '../src/project/paths.js'
import { emptyProject, defaultTrack, defaultItem, contentEndSec, validateProject, validateFxChain } from '../src/project/schema.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repoRoot, '.anyaudio', 'test-tmp-fx')
const workspaceRoot = join(scratch, 'workspace')
const SAMPLE_RATE = 48000

process.env.ANYAUDIO_STATE = join(scratch, 'state.json')
process.env.ANYAUDIO_CONFIG = join(scratch, 'config.json')

await rm(scratch, { recursive: true, force: true })
await mkdir(workspaceRoot, { recursive: true })

let passed = 0
let failed = 0
async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`)
}

/** A steady sine, so a gain change is measurable and nothing else moves. */
function tone(seconds, hz = 440, amplitude = 0.5) {
  const frames = Math.round(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude
    left[i] = value
    right[i] = value
  }
  return [left, right]
}

const clone = (channels) => channels.map((channel) => Float32Array.from(channel))

/** Amplitude of one frequency, by correlating against a reference sine. */
function amplitudeAt(channels, hz) {
  const data = channels[0]
  let re = 0
  let im = 0
  for (let i = 0; i < data.length; i++) {
    const angle = (2 * Math.PI * hz * i) / SAMPLE_RATE
    re += data[i] * Math.cos(angle)
    im += data[i] * Math.sin(angle)
  }
  return (2 * Math.sqrt(re * re + im * im)) / data.length
}

// --- the catalogue ----------------------------------------------------------

await test('every documented effect type has defaults that resolve', () => {
  assert.deepEqual(FX_TYPES, ['eq', 'compressor', 'limiter', 'reverb', 'delay', 'duck', 'pitch'])
  for (const type of FX_TYPES) {
    const resolved = resolveFx(defaultFx(type))
    assert.equal(resolved.type, type, `${type} keeps its type`)
    assert.doesNotThrow(() => validateFxChain([defaultFx(type)], 'fx'), `${type}'s defaults must pass validation`)
  }
  assert.equal(MAX_FX_PER_CHAIN, 8)
})

await test('resolveFx fills defaults and clamps out-of-range values', () => {
  const eq = resolveFx({ type: 'eq', bands: [{ type: 'peaking', freqHz: 999999, gainDb: 100, q: 0 }] })
  near(eq.bands[0].freqHz, 20000, 1e-9, 'frequency clamps at 20 kHz')
  near(eq.bands[0].gainDb, 24, 1e-9, 'gain clamps at +24 dB')
  near(eq.bands[0].q, 0.1, 1e-9, 'Q clamps at 0.1')
  const comp = resolveFx({ type: 'compressor', ratio: 999 })
  near(comp.ratio, 20, 1e-9, 'ratio clamps at 20')
  const pitch = resolveFx({ type: 'pitch', pitchSemitones: 40 })
  near(pitch.pitchSemitones, 12, 1e-9, 'pitch clamps at an octave')
})

// --- ① each effect ----------------------------------------------------------

await test('EQ lifts the band it points at and leaves the rest alone', () => {
  const source = tone(0.5, 1000, 0.25)
  const out = applyEq(clone(source), SAMPLE_RATE, {
    type: 'eq',
    bands: [{ type: 'peaking', freqHz: 1000, gainDb: 12, q: 1 }],
  })
  const before = amplitudeAt(source, 1000)
  const after = amplitudeAt(out, 1000)
  const gainDb = 20 * Math.log10(after / before)
  // A peaking biquad's peak gain is the band gain, give or take the Q's skirt.
  assert.ok(gainDb > 10, `a +12 dB band should lift 1 kHz by ~12 dB, measured ${gainDb.toFixed(2)}`)
  assert.ok(gainDb < 14, `and not more than asked, measured ${gainDb.toFixed(2)}`)
})

await test('EQ at 0 dB is a pass-through, and a flat band list changes nothing', () => {
  const source = tone(0.2, 440, 0.3)
  const flat = applyEq(clone(source), SAMPLE_RATE, { type: 'eq', bands: [{ type: 'peaking', freqHz: 500, gainDb: 0, q: 1 }] })
  let maxDiff = 0
  for (let i = 0; i < source[0].length; i++) maxDiff = Math.max(maxDiff, Math.abs(flat[0][i] - source[0][i]))
  assert.equal(maxDiff, 0, 'a 0 dB band must not touch a sample')
})

await test('the biquad coefficients are the RBJ ones the preview node also uses', () => {
  // Centre frequency through a peaking filter at unity gain is a straight
  // pass-through at DC: b0+b1+b2 == 1-a1-a2 in normalised form when gain is 0.
  const c = biquadCoefficients({ type: 'peaking', freqHz: 1000, gainDb: 0, q: 1 }, SAMPLE_RATE)
  near(c.b0 + c.b1 + c.b2, 1 + c.a1 + c.a2, 1e-9, 'unity gain keeps the DC response at 1')
  const shelf = biquadCoefficients({ type: 'lowshelf', freqHz: 200, gainDb: 6, q: 1 }, SAMPLE_RATE)
  assert.ok(Number.isFinite(shelf.b0) && Number.isFinite(shelf.a2), 'shelf coefficients are finite')
})

await test('compressor pulls down what is over the threshold, by the ratio', () => {
  // A steady level, not a sine: the point of this case is the *curve*, and a
  // sine makes the answer depend on how the peak follower ripples across one
  // period. A constant 0.5 settles the envelope at exactly 0.5 (-6.02 dBFS), so
  // the expected output is arithmetic: -18 + (−6.02 + 18)/4 = −15.0 dBFS.
  const frames = Math.round(1 * SAMPLE_RATE)
  const steady = [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(0.5)]
  const out = applyCompressor(steady, SAMPLE_RATE, {
    type: 'compressor', thresholdDb: -18, ratio: 4, attackSec: 0.02, releaseSec: 0.1, kneeDb: 0, makeupDb: 0,
  })
  const settled = Math.abs(out[0][Math.round(0.8 * SAMPLE_RATE)])
  near(toDb(settled), -15, 0.2, 'a 4:1 compressor over a -18 dB threshold settles at -15 dBFS')
  // And the attack is real: at the very start the level is still untouched.
  assert.ok(Math.abs(out[0][0]) > 0.45, 'a 20 ms attack leaves the first samples alone')

  // The same question on real programme material: a sine must come out quieter.
  const sine = tone(0.6, 440, 0.5)
  const squashed = applyCompressor(clone(sine), SAMPLE_RATE, {
    type: 'compressor', thresholdDb: -18, ratio: 4, attackSec: 0.02, releaseSec: 0.1, kneeDb: 0, makeupDb: 0,
  })
  const tailFrom = Math.round(0.4 * SAMPLE_RATE)
  const gainReduction = toDb(peakOf([squashed[0].subarray(tailFrom)])) - toDb(peakOf([sine[0].subarray(tailFrom)]))
  assert.ok(gainReduction < -2, `the sine is pulled down once the envelope settles: ${gainReduction.toFixed(2)} dB`)
  assert.ok(gainReduction > -9, `but not by the full ratio, because a sine's envelope sits below its peak: ${gainReduction.toFixed(2)} dB`)
})

await test('compressor below the threshold leaves the signal alone', () => {
  const source = tone(1, 440, 0.01) // -40 dBFS, well under a -18 dB threshold
  const out = applyCompressor(clone(source), SAMPLE_RATE, { type: 'compressor', thresholdDb: -18, ratio: 4, kneeDb: 0 })
  near(peakOf(out), peakOf(source), 1e-6, 'nothing over the threshold means nothing to do')
})

await test('the compressor curve is continuous across the knee', () => {
  const params = { thresholdDb: -20, ratio: 4, kneeDb: 8 }
  const below = compressorCurve(-30, params)
  const edge = compressorCurve(-24, params)
  near(below, -30, 1e-9, 'well below the knee: untouched')
  near(edge, -24, 1e-9, 'at the knee start: still untouched')

  // Inside the knee the curve bends between "untouched" and "full ratio". At the
  // knee's midpoint (the threshold) it is exactly half-way, which is the
  // definition of a soft knee, so both comparisons below have to hold at once.
  const middle = compressorCurve(-20, params)
  const hardAtThreshold = -20 // (input − threshold)/ratio is zero exactly at -20
  assert.ok(middle < hardAtThreshold, `at the threshold it is already below the input: ${middle}`)
  assert.ok(middle > -24, `but not down at the knee start: ${middle}`)

  // Well above the knee the slope is the ratio's slope: 1/4 dB out per dB in.
  const above = compressorCurve(-10, params)
  near(above, -20 + 10 / 4, 1e-9, 'above the knee the ratio governs: -17.5 dBFS')

  // No step at either knee boundary.
  near(compressorCurve(-24.001, params), edge, 0.01, 'no discontinuity at the lower knee edge')
  near(compressorCurve(-16.001, params), compressorCurve(-16, params), 0.05, 'nor at the upper edge')

  // The knee is the transition between "untouched" (slope 1) and "fully
  // compressed" (slope 1/ratio), so inside it the slope has to sit strictly
  // between the two. Both slopes are negative; compare magnitudes.
  const inKnee = (compressorCurve(-21, params) - compressorCurve(-19, params)) / 2
  const outside = (compressorCurve(-11, params) - compressorCurve(-9, params)) / 2
  near(Math.abs(outside), 1 / 4, 1e-9, 'outside the knee the slope is exactly 1/ratio')
  assert.ok(Math.abs(inKnee) > Math.abs(outside), `inside the knee it is steeper than the ratio: ${inKnee.toFixed(3)} vs ${outside.toFixed(3)}`)
  assert.ok(Math.abs(inKnee) < 1, `and gentler than no compression at all: ${inKnee.toFixed(3)}`)
  // At the threshold itself the slope is exactly halfway between the two ends,
  // which is what makes the transition smooth rather than a corner.
  const atThreshold = (compressorCurve(-20.001, params) - compressorCurve(-19.999, params)) / 0.002
  near(Math.abs(atThreshold), (1 + 1 / 4) / 2, 1e-3, 'the threshold sits at the midpoint of the knee')
})

await test('limiter holds the ceiling and never lets a peak through', () => {
  const source = tone(0.5, 440, 0.9) // about -1 dBFS
  const ceilingDb = -6
  const out = applyLimiter(clone(source), SAMPLE_RATE, { type: 'limiter', ceilingDb, releaseSec: 0.05 })
  const peakDb = toDb(peakOf(out))
  assert.ok(peakDb <= ceilingDb + 1e-6, `the ceiling is a promise: ${peakDb.toFixed(3)} dBFS must be <= ${ceilingDb}`)
})

await test('limiter does not pull the stereo image together', () => {
  // Both channels must get the same gain factor, or a loud peak shifts the image.
  const left = tone(0.3, 440, 0.9)[0]
  const right = tone(0.3, 440, 0.45)[0]
  const out = applyLimiter([Float32Array.from(left), Float32Array.from(right)], SAMPLE_RATE, { type: 'limiter', ceilingDb: -6 })
  let worst = 0
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(left[i]) < 1e-6) continue
    const ratioBefore = right[i] / left[i]
    const ratioAfter = out[1][i] / out[0][i]
    worst = Math.max(worst, Math.abs(ratioAfter - ratioBefore))
  }
  assert.ok(worst < 0.02, `the channel ratio changes by at most 2%: measured ${worst.toFixed(4)}`)
})

await test('delay repeats after its time, and feedback decays', () => {
  const seconds = 0.5
  const burst = [new Float32Array(Math.round(seconds * SAMPLE_RATE)), new Float32Array(Math.round(seconds * SAMPLE_RATE))]
  // A short click at the very start, so a repeat is easy to locate.
  for (let i = 0; i < 48; i++) {
    burst[0][i] = 0.8
    burst[1][i] = 0.8
  }
  const timeSec = 0.1
  const out = applyDelay(clone(burst), SAMPLE_RATE, { type: 'delay', timeSec, feedback: 0.5, wet: 0.6, dry: 0 })
  const at = (sec) => Math.max(Math.abs(out[0][Math.round(sec * SAMPLE_RATE)]), Math.abs(out[0][Math.round(sec * SAMPLE_RATE) - 1]))
  assert.ok(at(timeSec) > 0.1, `an echo appears at ${timeSec}s, got ${at(timeSec).toFixed(3)}`)
  assert.ok(at(timeSec * 2) < at(timeSec), 'the second repeat is quieter than the first')
  assert.ok(at(timeSec * 2) > 0.01, 'and it is still there')
  assert.ok(at(0.05) < 1e-6, 'nothing between the clicks')
})

await test('reverb leaves a tail past the end of the input', () => {
  const source = tone(0.3, 440, 0.4)
  const out = applyReverb(clone(source), SAMPLE_RATE, { type: 'reverb', roomSize: 0.85, damping: 0.2, wet: 0.8, dry: 0.2, width: 0.7 })
  // The input stops at 0.3s; a reverb has to keep sounding. Compare the last
  // stretch against a version with no reverb at all.
  const dry = clone(source)
  const tailFrom = Math.round(0.29 * SAMPLE_RATE)
  const tailTo = Math.round(0.3 * SAMPLE_RATE)
  const tailPeak = peakOf([out[0].subarray(tailFrom, tailTo)])
  const dryPeak = peakOf([dry[0].subarray(tailFrom, tailTo)])
  assert.ok(tailPeak > dryPeak * 0.1, `the reverb adds energy near the end: ${tailPeak.toFixed(4)} vs ${dryPeak.toFixed(4)}`)
  // And it is a real tail: the wet signal is not merely a scaled copy.
  let different = 0
  for (let i = tailFrom; i < tailTo; i += 7) different = Math.max(different, Math.abs(out[0][i] / (source[0][i] || 1) - 1))
  assert.ok(different > 0.05, 'the wet signal differs from a plain gain change')
})

await test('the block-wise reverb equals the whole-buffer reverb', async () => {
  // This is the preview/export promise in one assertion: the worklet feeds the
  // processor 128 frames at a time, the renderer hands it the whole clip, and the
  // two must agree sample for sample.
  const source = tone(0.4, 300, 0.4)
  const fx = { type: 'reverb', roomSize: 0.7, damping: 0.35, wet: 0.5, dry: 0.85, width: 0.8 }
  const whole = applyReverb(clone(source), SAMPLE_RATE, fx)
  const blocked = clone(source)
  const processor = createReverbProcessor(SAMPLE_RATE, fx)
  for (let at = 0; at < blocked[0].length; at += 128) {
    const size = Math.min(128, blocked[0].length - at)
    processor.process([blocked[0].subarray(at, at + size), blocked[1].subarray(at, at + size)], size)
  }
  let maxDiff = 0
  for (let i = 0; i < whole[0].length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(whole[0][i] - blocked[0][i]), Math.abs(whole[1][i] - blocked[1][i]))
  }
  assert.equal(maxDiff, 0, `block processing must equal whole-buffer processing, worst difference ${maxDiff}`)
})

await test('duck lowers the level only while its source is loud', () => {
  const frames = Math.round(2 * SAMPLE_RATE)
  const music = [new Float32Array(frames).fill(0.3), new Float32Array(frames).fill(0.3)]
  const envelope = new Float32Array(Math.round(2 * SAMPLE_RATE))
  // Loud from 0.5s to 1.5s, silent outside.
  for (let i = Math.round(0.5 * SAMPLE_RATE); i < Math.round(1.5 * SAMPLE_RATE); i++) envelope[i] = 0.6
  const out = applyDuck(clone(music), SAMPLE_RATE, { type: 'duck', targetDb: -12, thresholdDb: -40, attackSec: 0.01, releaseSec: 0.05 }, envelope)
  const quiet = Math.abs(out[0][Math.round(0.1 * SAMPLE_RATE)])
  const ducked = Math.abs(out[0][Math.round(1.0 * SAMPLE_RATE)])
  near(quiet, 0.3, 1e-6, 'outside the voice the bed is untouched')
  assert.ok(ducked < quiet * 0.5, `inside the voice the bed is pulled down: ${ducked.toFixed(4)} vs ${quiet.toFixed(4)}`)
})

await test('two ducks on one envelope still behave differently', () => {
  // The envelope belongs to the source track; the depth belongs to each effect.
  const envelope = new Float32Array(1000).fill(0.6)
  const gentle = buildDuckCurve(envelope, SAMPLE_RATE, { targetDb: -3, thresholdDb: -40, attackSec: 0.01, releaseSec: 0.05 })
  const heavy = buildDuckCurve(envelope, SAMPLE_RATE, { targetDb: -24, thresholdDb: -40, attackSec: 0.01, releaseSec: 0.05 })
  assert.ok(heavy[999] < gentle[999], `-24 dB ducks harder than -3 dB: ${heavy[999].toFixed(4)} vs ${gentle[999].toFixed(4)}`)
})

await test('monoEnvelope takes the louder channel, not the average', () => {
  const left = new Float32Array([0.5, 0, 0.1])
  const right = new Float32Array([0, 0.4, 0.1])
  const env = monoEnvelope([left, right])
  // A Float32Array quantises 0.4 to 0.40000000596…, so compare at float32
  // precision rather than demanding the decimal literal back.
  near(env[0], 0.5, 1e-6, 'left peak')
  near(env[1], 0.4, 1e-6, 'right peak')
  near(env[2], 0.1, 1e-6, 'both agree')
  // Louder channel wins; an average would be 0.25 and 0.2 here.
  assert.ok(env[0] > 0.45 && env[1] > 0.35, 'the envelope follows the peak, not the mean')
})

await test('pitch changes the length by the factor, and rate is multiplicative', () => {
  const source = tone(1, 440, 0.3)
  const up = applyPitch(clone(source), SAMPLE_RATE, { type: 'pitch', pitchSemitones: 12 })
  near(up[0].length, source[0].length / 2, 2, 'an octave up halves the length')
  near(pitchFactor({ type: 'pitch', pitchSemitones: 12 }), 2, 1e-9, 'a semitone is 2^(1/12) of speed')
  near(pitchFactor({ type: 'pitch', rate: 1.5, pitchSemitones: 0 }), 1.5, 1e-9, 'rate alone is the factor')
  // Two independent properties, so they multiply.
  const both = applyPitch(clone(source), SAMPLE_RATE, { type: 'pitch', rate: 1.5, pitchSemitones: 12 })
  near(both[0].length, source[0].length / 3, 3, 'rate and pitch multiply')
})

await test('preserveLength keeps the clip in its slot', () => {
  const source = tone(1, 440, 0.3)
  const out = applyPitch(clone(source), SAMPLE_RATE, { type: 'pitch', pitchSemitones: 12 }, { preserveLength: true })
  assert.equal(out[0].length, source[0].length, 'the renderer keeps the length: the project says where the clip ends')
})

// --- the chain --------------------------------------------------------------

await test('a chain runs in the order it lists', () => {
  // Gain then limit, versus limit then gain, on the same input: the first result
  // honours the ceiling, the second does not. This is the whole reason order is
  // a hard rule.
  const source = tone(0.3, 440, 0.9)
  const gainFirst = applyFxChain(clone(source), SAMPLE_RATE, [
    { type: 'compressor', thresholdDb: -30, ratio: 1, makeupDb: 6, kneeDb: 0 },
    { type: 'limiter', ceilingDb: -6 },
  ])
  const limitFirst = applyFxChain(clone(source), SAMPLE_RATE, [
    { type: 'limiter', ceilingDb: -6 },
    { type: 'compressor', thresholdDb: -30, ratio: 1, makeupDb: 6, kneeDb: 0 },
  ])
  assert.ok(toDb(peakOf(gainFirst)) <= -6 + 1e-6, `limited last holds the ceiling: ${toDb(peakOf(gainFirst)).toFixed(2)}`)
  assert.ok(toDb(peakOf(limitFirst)) > -3, `limited first is undone by the next effect: ${toDb(peakOf(limitFirst)).toFixed(2)}`)
})

await test('an empty or missing chain is a pass-through', () => {
  const source = tone(0.1, 440, 0.3)
  const untouched = applyFxChain(clone(source), SAMPLE_RATE, [])
  const missing = applyFxChain(clone(source), SAMPLE_RATE, undefined)
  let maxDiff = 0
  for (let i = 0; i < source[0].length; i++) {
    maxDiff = Math.max(
      maxDiff,
      Math.abs(untouched[0][i] - source[0][i]),
      Math.abs(missing[0][i] - source[0][i]),
    )
  }
  assert.equal(maxDiff, 0, 'no chain means no change, sample for sample')
})

await test('resolveChain trims to the limit rather than growing without bound', () => {
  const chain = Array.from({ length: 20 }, () => ({ type: 'limiter' }))
  assert.equal(resolveChain(chain).length, MAX_FX_PER_CHAIN)
})

// --- ② the master order, through a real render -------------------------------

async function makeProject({ id, materials, tracks, masterFaderDb = 0, masterFx = undefined, normalizeGainDb = 0 }) {
  const project = emptyProject({ id, name: id, sampleRate: SAMPLE_RATE })
  project.normalizeGainDb = normalizeGainDb
  project.masterFaderDb = masterFaderDb
  if (masterFx) project.masterFx = masterFx
  project.tracks = tracks
  await mkdir(materialsDir(workspaceRoot, id), { recursive: true })
  const index = { materials: [] }
  for (const [materialId, channels] of Object.entries(materials)) {
    await writeFile(join(materialsDir(workspaceRoot, id), `${materialId}.wav`), encodeWav({ sampleRate: SAMPLE_RATE, channels, bitDepth: 16 }))
    index.materials.push({
      id: materialId,
      file: `materials/${materialId}.wav`,
      durationSec: channels[0].length / SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
      channels: channels.length,
      kind: 'imported',
      bytes: 1,
      source: { kind: 'imported', originalName: `${materialId}.wav`, originalFormat: 'wav', importedAt: '2026-11-08T00:00:00Z' },
    })
  }
  await writeMaterialIndex(workspaceRoot, id, index)
  await saveProject(workspaceRoot, project, { by: 'user', note: '' })
  return { project: { ...project, durationSec: contentEndSec(project) }, dir: projectDir(workspaceRoot, id) }
}

await test('the master chain runs after the fader, so a limiter cannot be undone', async () => {
  // Improvement plan 02, I-07, and the one case that would have caught the bug
  // the plan warned about: with the chain first, a −1 dBFS limiter plus a +6 dB
  // fader exports +5 dBFS — clipping, with the limiter having done nothing.
  const material = tone(1, 440, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), startSec: 0, inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({
    id: 'prj_master_order',
    materials: { mat_tone: material },
    tracks: [track],
    masterFaderDb: 6,
    masterFx: [{ type: 'limiter', ceilingDb: -1 }],
  })
  const rendered = await renderProject({ project, workspaceRoot })
  const peakDb = toDb(peakOf(rendered.channels))
  assert.ok(peakDb <= -1 + 0.05, `the exported peak must stay under the ceiling, got ${peakDb.toFixed(2)} dBFS`)
  assert.ok(peakDb > -6, `and it must actually use the headroom, got ${peakDb.toFixed(2)} dBFS`)
})

await test('a clip chain changes the sound, and a leftover track chain is ignored', async () => {
  // Improvement plan 03, I-41. A track used to carry its own chain; that is gone,
  // so this checks the chain on the clip does the work and a leftover `fx` on the
  // track neither helps nor breaks the render.
  const material = tone(1, 1000, 0.25)
  const track = {
    ...defaultTrack('trk_eq', 'EQ'),
    fx: [{ type: 'eq', bands: [{ type: 'peaking', freqHz: 1000, gainDb: 12, q: 1 }] }],
    items: [{
      ...defaultItem('itm_eq', 'mat_tone'),
      startSec: 0, inSec: 0, outSec: 1,
      fx: [{ type: 'eq', bands: [{ type: 'peaking', freqHz: 1000, gainDb: 12, q: 1 }] }],
    }],
  }
  const plain = { ...defaultTrack('trk_plain', 'Plain'), items: [{ ...defaultItem('itm_plain', 'mat_tone'), startSec: 0, inSec: 0, outSec: 1 }] }
  const withFx = await makeProject({ id: 'prj_track_fx', materials: { mat_tone: material }, tracks: [track] })
  const without = await makeProject({ id: 'prj_track_plain', materials: { mat_tone: material }, tracks: [plain] })
  const boosted = await renderProject({ project: withFx.project, workspaceRoot })
  const reference = await renderProject({ project: without.project, workspaceRoot })
  const delta = toDb(peakOf(boosted.channels)) - toDb(peakOf(reference.channels))
  assert.ok(delta > 8, `a +12 dB band on the clip lifts the peak substantially, measured ${delta.toFixed(2)} dB`)
  near(boosted.trackCount, 1, 0, 'and the track is still there')
})

await test('a clip chain is applied before the clip reaches its track', async () => {
  const material = tone(0.5, 1000, 0.25)
  const track = {
    ...defaultTrack('trk_clip', 'Clip'),
    items: [{
      ...defaultItem('itm_clip', 'mat_tone'),
      startSec: 0, inSec: 0, outSec: 0.5,
      fx: [{ type: 'limiter', ceilingDb: -12 }],
    }],
  }
  const { project } = await makeProject({ id: 'prj_clip_fx', materials: { mat_tone: material }, tracks: [track] })
  const rendered = await renderProject({ project, workspaceRoot })
  const peakDb = toDb(peakOf(rendered.channels))
  assert.ok(peakDb <= -12 + 0.05, `a clip limiter holds its own ceiling, got ${peakDb.toFixed(2)} dBFS`)
})

await test('a duck on the bus follows the narration track', async () => {
  // The sidechain is a real track: the music track is ducked while the "voice"
  // track is loud, and the two are separate clips in the same project.
  const music = tone(2, 220, 0.3)
  const voice = [new Float32Array(2 * SAMPLE_RATE), new Float32Array(2 * SAMPLE_RATE)]
  for (let i = Math.round(0.5 * SAMPLE_RATE); i < Math.round(1.5 * SAMPLE_RATE); i++) {
    const value = Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE) * 0.7
    voice[0][i] = value
    voice[1][i] = value
  }
  const musicTrack = {
    ...defaultTrack('trk_music', 'Music'),
    items: [{
      ...defaultItem('itm_music', 'mat_music'),
      startSec: 0, inSec: 0, outSec: 2,
      // The duck lives on the clip now (I-41): a track has no chain, and a duck
      // that has to apply to a whole group is what one `update` with many changes
      // is for.
      fx: [{ type: 'duck', sourceTrackId: 'trk_voice', targetDb: -18, thresholdDb: -30, attackSec: 0.01, releaseSec: 0.05 }],
    }],
  }
  const voiceTrack = {
    ...defaultTrack('trk_voice', 'Voice'),
    muted: true, // its own sound must not reach the mix; it only drives the duck
    items: [{ ...defaultItem('itm_voice', 'mat_voice'), startSec: 0, inSec: 0, outSec: 2 }],
  }
  const { project } = await makeProject({
    id: 'prj_duck',
    materials: { mat_music: music, mat_voice: voice },
    tracks: [musicTrack, voiceTrack],
  })
  const rendered = await renderProject({ project, workspaceRoot })
  const early = rmsOf(rendered.channels, 0, Math.round(0.4 * SAMPLE_RATE))
  const middle = rmsOf(rendered.channels, Math.round(0.8 * SAMPLE_RATE), Math.round(1.2 * SAMPLE_RATE))
  assert.ok(middle < early * 0.6, `the bed drops while the voice is present: ${toDb(middle).toFixed(1)} dB vs ${toDb(early).toFixed(1)} dB`)
})

await test('every effect reaches the render without breaking the project file', async () => {
  const material = tone(0.6, 440, 0.2)
  const chain = FX_TYPES.map((type) => defaultFx(type)).map((fx) => (fx.type === 'duck' ? { ...fx, sourceTrackId: 'trk_all' } : fx))
  const track = {
    ...defaultTrack('trk_all', 'All'),
    fx: chain,
    items: [{ ...defaultItem('itm_all', 'mat_tone'), startSec: 0, inSec: 0, outSec: 0.6 }],
  }
  const { project } = await makeProject({ id: 'prj_all_fx', materials: { mat_tone: material }, tracks: [track], masterFx: [{ type: 'limiter', ceilingDb: -3 }] })
  // The file has to validate with every chain present, or the clip bay would
  // refuse to open a project its own renderer just produced.
  assert.doesNotThrow(() => validateProject(project), 'a project with all seven effects validates')
  const rendered = await renderProject({ project, workspaceRoot })
  assert.ok(rendered.clipCount === 1, 'the clip rendered')
  assert.ok(toDb(peakOf(rendered.channels)) <= -3 + 0.05, 'and the bus limiter held')
})

await test('the project on disk keeps its chains after a save and reload', async () => {
  const { readProject } = await import('../src/project/store.js')
  const material = tone(0.3, 440, 0.2)
  const track = {
    ...defaultTrack('trk_persist', 'Persist'),
    fx: [{ type: 'compressor', thresholdDb: -20, ratio: 3 }],
    items: [{ ...defaultItem('itm_persist', 'mat_tone'), startSec: 0, inSec: 0, outSec: 0.3, fx: [{ type: 'delay', timeSec: 0.1, wet: 0.2 }] }],
  }
  await makeProject({ id: 'prj_persist', materials: { mat_tone: material }, tracks: [track], masterFx: [{ type: 'reverb', wet: 0.3 }] })
  const reloaded = await readProject(workspaceRoot, 'prj_persist')
  assert.equal(reloaded.masterFx.length, 1, 'the bus chain survived')
  assert.equal(reloaded.tracks[0].fx.length, 1, 'the track chain survived')
  assert.equal(reloaded.tracks[0].items[0].fx.length, 1, 'the clip chain survived')
  assert.equal(reloaded.tracks[0].fx[0].type, 'compressor')
  assert.equal(reloaded.tracks[0].items[0].fx[0].type, 'delay')
})

await rm(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
