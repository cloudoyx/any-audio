/**
 * One source for the mix parameters (improvement plan 02, I-04).
 *
 * The failure this guards against is not "the two chains differ today" — that can
 * be fixed once. It is "the two chains compute their own copy", which has to be
 * reconciled again for every parameter added later. So most of these cases are
 * source assertions: the renderer and the preview must both take their numbers
 * from mix-params.js, and neither may restate a dB conversion, a pan law or a
 * fade shape.
 *
 * The last case is the one that would catch a real regression: the same project
 * arranged through the renderer and through the preview's scheduling must agree
 * sample for sample, fades included.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repoRoot, '.anyaudio', 'test-tmp-mix-params')
const workspaceRoot = join(scratch, 'workspace')

process.env.ANYAUDIO_STATE = join(scratch, 'state.json')
process.env.ANYAUDIO_CONFIG = join(scratch, 'config.json')

await rm(scratch, { recursive: true, force: true })
await mkdir(workspaceRoot, { recursive: true })

const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n')

const {
  dbToGain, panGains, itemParams, masterParams,
  resolveTrackGain, audibleTracks, fadeShape, fadeCurve, clipMixGain,
} = await import('../src/client/clipbay/mix-params.js')

let passed = 0
let failed = 0

function test(name, run) {
  return Promise.resolve()
    .then(run)
    .then(() => {
      passed++
      console.log(`ok   ${name}`)
    })
    .catch((error) => {
      failed++
      console.log(`FAIL ${name}`)
      console.log(`     ${error.message}`)
    })
}

function close(actual, expected, label, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}: expected ${expected}, got ${actual}`)
}

const SAMPLE_RATE = 48000

// --- the module itself -------------------------------------------------------

await test('mix-params has no imports at all, so both bundles can inline it', () => {
  const source = read('src/client/clipbay/mix-params.js')
  assert.doesNotMatch(source, /^\s*import\s/m, 'no imports: it must not reach for wav.js (which uses Buffer) or anything else')
  // The comment above explains why Buffer is off limits; the code must not use it.
  assert.doesNotMatch(source, /\bBuffer\s*[.(]/, 'no Buffer use: this file is bundled into the browser')
})

await test('dbToGain and panGains keep their exact definitions', () => {
  assert.equal(dbToGain(0), 1, '0 dB is exactly a pass-through')
  close(dbToGain(-6), 0.5011872336, '-6 dB', 1e-6)
  close(dbToGain(6), 1.99526231, '+6 dB', 1e-6)
  assert.deepEqual(panGains(0), [1, 1], 'centre is a true bypass, not 0.707')
  const [left, right] = panGains(-0.5)
  close(left ** 2 + right ** 2, 1, 'equal power off-centre', 1e-9)
  const [hardLeft, hardLeftRight] = panGains(-1)
  close(hardLeft, 1, 'hard left keeps the left channel', 1e-12)
  close(hardLeftRight, 0, 'and silences the right one', 1e-12)
  const [hardRightLeft, hardRight] = panGains(1)
  close(hardRightLeft, 0, 'hard right silences the left channel', 1e-12)
  close(hardRight, 1, 'and keeps the right one', 1e-12)
})

await test('fadeShape is the cosine the renderer always used', () => {
  close(fadeShape(0), 0, 'starts at silence')
  close(fadeShape(0.5), 0.5, 'halfway up')
  close(fadeShape(1), 1, 'ends at unity')
  close(fadeShape(0.25), 0.5 - 0.5 * Math.cos(Math.PI * 0.25), 'quarter point matches the closed form')
  for (let i = 1; i <= 32; i++) {
    assert.ok(fadeShape(i / 32) >= fadeShape((i - 1) / 32), 'the curve never goes backwards')
  }
})

// --- the parameters ----------------------------------------------------------

await test('itemParams takes the clip pan alone and clamps it', () => {
  // Improvement plan 03, I-41: a track has no pan any more, so the clip's value
  // is the whole story. Two places for the same decision is exactly the
  // disagreement this module exists to prevent.
  assert.equal(itemParams({ pan: 0.4, gainDb: 0 }, { pan: 0.4 }).pan, 0.4, 'the track pan is gone, not added')
  assert.equal(itemParams({ pan: 1, gainDb: 0 }, {}).pan, 1, 'the clip value is kept')
  assert.equal(itemParams({ pan: -1, gainDb: 0 }, {}).pan, -1, 'on both ends')
  assert.equal(itemParams({ pan: 7, gainDb: 0 }, {}).pan, 1, 'and it is clamped')
})

await test('itemParams reports mute from either side and keeps the gain factors apart', () => {
  assert.equal(itemParams({ muted: true }, { muted: false }).muted, true, 'a muted clip is muted')
  assert.equal(itemParams({ muted: false }, { muted: true }).muted, true, 'a muted track mutes its clips')
  const params = itemParams({ gainDb: -3 }, {})
  close(params.gain, dbToGain(-3), 'the clip gain factor')
  assert.equal(params.gainDb, -3, 'and the dB it came from')
})

await test('masterParams is one sum of the frozen normalisation and the fader', () => {
  const params = masterParams({ normalizeGainDb: 4.5, masterFaderDb: -1.5 })
  assert.equal(params.gainDb, 3, 'the two add up once')
  close(params.gain, dbToGain(3), 'and become one linear gain')
  assert.equal(masterParams({}).gainDb, 0, 'an untouched project is unity')
})

await test('resolveTrackGain is only mute and solo: 1 or 0, never a volume', () => {
  // Improvement plan 03, I-41. A track used to carry a fader; what is left is
  // its one audible property — being switched off, or being the one soloed.
  assert.equal(resolveTrackGain({}, false), 1)
  assert.equal(resolveTrackGain({ volumeDb: -20 }, false), 1, 'a leftover volume field is ignored, not applied')
  assert.equal(resolveTrackGain({ muted: true }, false), 0, 'mute wins')
  assert.equal(resolveTrackGain({ solo: false }, true), 0, 'someone else soloed')
  assert.equal(resolveTrackGain({ solo: true }, true), 1, 'this one is soloed')
  assert.equal(resolveTrackGain({ solo: true, muted: true }, true), 0, 'muted solo is still silent')
})

await test('audibleTracks drops muted tracks and honours solo', () => {
  const plain = [{ id: 'a' }, { id: 'b', muted: true }]
  assert.deepEqual(audibleTracks(plain).map((t) => t.id), ['a'])
  const solo = [{ id: 'a' }, { id: 'b', solo: true }]
  assert.deepEqual(audibleTracks(solo).map((t) => t.id), ['b'])
  assert.deepEqual(audibleTracks(null), [])
})

// --- one shape per fade -------------------------------------------------------

await test('fadeCurve gives the same numbers the renderer multiplies by', async () => {
  const { applyFades } = await import('../src/audio/mix.js')
  const frames = 48000 // one second
  const curve = fadeCurve(frames, SAMPLE_RATE, 0.25, 0.25)
  const channel = new Float32Array(frames).fill(1)
  const [faded] = applyFades([channel, channel], SAMPLE_RATE, 0.25, 0.25)
  for (let i = 0; i < frames; i += 97) {
    close(faded[i], curve[i], `frame ${i}`, 1e-6)
  }
  assert.ok(curve[0] < 1e-6, 'a fade-in starts at silence')
  assert.ok(curve[frames - 1] < 1e-6, 'a fade-out ends at silence')
  close(curve[frames / 2], 1, 'and the middle is untouched', 1e-6)
})

await test('fadeCurve clamps fades longer than the clip instead of running past it', () => {
  const curve = fadeCurve(4800, SAMPLE_RATE, 10, 10) // 0.1s clip, two 10s fades
  assert.equal(curve.length, 4800, 'the curve is as long as the clip')
  for (let i = 0; i < curve.length; i++) {
    assert.ok(curve[i] >= 0 && curve[i] <= 1, `frame ${i} stays in range: ${curve[i]}`)
  }
})

// --- the two chains must not restate any of it ---------------------------------

await test('the renderer and the preview both import mix-params', () => {
  const renderer = read('src/project/render.js')
  const preview = read('src/client/clipbay/audio.js')
  assert.match(renderer, /from '\.\.\/client\/clipbay\/mix-params\.js'/, 'render.js imports it')
  assert.match(preview, /from '\.\/mix-params\.js'/, 'audio.js imports it')
  for (const [name, source] of [['render.js', renderer], ['audio.js', preview]]) {
    assert.match(source, /itemParams\(/, `${name} reads clip parameters from it`)
    assert.match(source, /masterParams\(/, `${name} reads the bus gain from it`)
    assert.doesNotMatch(source, /10 \*\* \(\s*[^)]*\/ 20\)/, `${name} must not restate dB → gain`)
    assert.doesNotMatch(source, /0\.5 - 0\.5 \* Math\.cos/, `${name} must not restate the fade curve`)
    assert.doesNotMatch(source, /Math\.cos\(angle\)[\s\S]{0,40}Math\.sin\(angle\)/, `${name} must not restate the pan law`)
  }
  assert.match(renderer, /resolveTrackGain\(/, 'the renderer takes the track gain from it too')
})

await test('the audio helpers re-export rather than redefine', () => {
  // `src/audio/mix.js` applies the parameters to plain arrays; it must not keep a
  // second conversion of its own, or the renderer would have two to choose from.
  const mixer = read('src/audio/mix.js')
  assert.match(mixer, /from '\.\.\/client\/clipbay\/mix-params\.js'/, 'mix.js imports the shared module')
  assert.doesNotMatch(mixer, /export function dbToGain/, 'it re-exports dbToGain, it does not own it')
  assert.doesNotMatch(mixer, /export function panGains/, 'nor the pan law')
})

// --- a real render against the preview's own numbers ---------------------------

await test('the rendered samples equal the preview schedule applied to the same clip', async () => {
  const { encodeWav } = await import('../src/audio/wav.js')
  const { renderProject } = await import('../src/project/render.js')
  const { writeMaterialIndex, saveProject } = await import('../src/project/store.js')
  const { materialsDir } = await import('../src/project/paths.js')
  const { emptyProject, defaultTrack, defaultItem, contentEndSec } = await import('../src/project/schema.js')
  // The preview half pulls in react for the hook, which has nothing to do with
  // the numbers. Strip the imports and the hook, exactly as clipbay-playback does.
  // `API` is the one module-level value the stripped imports used to supply (the
  // worklet URL is built from it), so it is declared here instead.
  const previewSource = read('src/client/clipbay/audio.js')
    .replace(/^import .*$/gm, '')
    .replace(/export function usePlayback[\s\S]*$/m, '')
  const sharedSource = read('src/client/clipbay/mix-params.js')
  const { scheduleClips } = await import(
    `data:text/javascript;base64,${Buffer.from(`const API = '/api/dsh-any-audio'\n${sharedSource}\n${previewSource}`, 'utf8').toString('base64')}`
  )

  // A tone, so the only thing that varies is the gain the two chains apply to
  // it. One clip with both fades and a clip pan. No track volume or pan: since
  // I-41 a track has neither, and the parity being checked is exactly that the
  // two engines agree without one.
  const frames = SAMPLE_RATE
  const tone = new Float32Array(frames)
  for (let i = 0; i < frames; i++) tone[i] = Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE) * 0.5

  const project = emptyProject({ id: 'prj_parity', name: 'parity', sampleRate: SAMPLE_RATE })
  project.normalizeGainDb = 0
  project.masterFaderDb = 0
  project.tracks = [{
    ...defaultTrack('trk_parity', 'parity'),
    items: [{ ...defaultItem('itm_parity', 'mat_parity'), startSec: 0, inSec: 0, outSec: 1, gainDb: -2, pan: -0.5, fadeInSec: 0.2, fadeOutSec: 0.2 }],
  }]
  project.durationSec = contentEndSec(project)

  await mkdir(materialsDir(workspaceRoot, project.id), { recursive: true })
  await writeFile(
    join(materialsDir(workspaceRoot, project.id), 'mat_parity.wav'),
    encodeWav({ sampleRate: SAMPLE_RATE, channels: [tone, tone], bitDepth: 16 }),
  )
  await writeMaterialIndex(workspaceRoot, project.id, {
    materials: [{
      id: 'mat_parity',
      file: 'materials/mat_parity.wav',
      durationSec: 1,
      sampleRate: SAMPLE_RATE,
      channels: 2,
      kind: 'imported',
      bytes: 1,
      source: { kind: 'imported', originalName: 'mat_parity.wav', originalFormat: 'wav', importedAt: '2026-11-06T00:00:00Z' },
    }],
  })
  await saveProject(workspaceRoot, project, { by: 'user', note: '' })

  const rendered = await renderProject({ project, workspaceRoot })
  const entry = scheduleClips(project, 0)[0]
  assert.ok(entry, 'the preview schedules the clip')

  // What the preview promises: this clip gain over this span, that pan pair.
  const [panLeft, panRight] = panGains(entry.pan)
  const expectedCurve = fadeCurve(frames, SAMPLE_RATE, 0.2, 0.2)
  let checked = 0
  for (let i = 0; i < frames; i += 53) {
    const expected = tone[i] * entry.gain * expectedCurve[i]
    close(rendered.channels[0][i], expected * panLeft, `left channel frame ${i}`, 2e-4)
    close(rendered.channels[1][i], expected * panRight, `right channel frame ${i}`, 2e-4)
    checked++
  }
  assert.ok(checked > 100, `the comparison actually covered samples, got ${checked}`)
  // The parameters really are non-trivial: this would pass trivially at unity.
  assert.ok(Math.abs(entry.pan) > 1e-3, 'the clip is panned, so the parity check means something')
  assert.ok(Math.abs(entry.gain - 1) > 1e-3, 'and carries a gain')
})

await test('mute and solo silence a clip through the same rule before and during playback', () => {
  // The regression this covers: the scheduled path multiplied the track gain in,
  // the live path did not, so pressing M while the transport ran changed nothing
  // until the next play (improvement plan 04).
  const track = { id: 'trk_a', muted: false, solo: false, items: [] }
  const clip = { gainDb: -6, muted: false }
  close(clipMixGain(track, clip, false), dbToGain(-6), 'audible clip keeps its own gain')
  assert.equal(clipMixGain({ ...track, muted: true }, clip, false), 0, 'a muted track silences its clips')
  assert.equal(clipMixGain(track, clip, true), 0, 'another track being soloed silences this one')
  close(clipMixGain({ ...track, solo: true }, clip, true), dbToGain(-6), 'a soloed track stays audible')
  assert.equal(clipMixGain(track, { ...clip, muted: true }, false), 0, 'a muted clip is silent on an audible track')
})

await test('the live path uses clipMixGain instead of restating the arithmetic', () => {
  const audio = read(join('src', 'client', 'clipbay', 'audio.js'))
  const start = audio.indexOf('const applyMix = useCallback')
  assert.ok(start > 0, 'applyMix is still where the live graph is pushed')
  const applyMix = audio.slice(start, audio.indexOf('\n  }, [])', start))
  assert.match(applyMix, /clipMixGain\(track, item, anySolo\)/, 'the live path asks the shared rule')
  assert.doesNotMatch(applyMix, /resolveTrackGain\(/, 'and does not compute its own track gain')
})

await rm(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
