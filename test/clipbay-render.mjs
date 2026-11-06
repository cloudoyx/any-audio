/**
 * Renderer acceptance (plan M3).
 *
 * Every case compares the renderer against arithmetic done by hand in this file
 * rather than against its own output, so the test can actually fail: gains add
 * up, fades follow the equal-power shape, a muted or non-soloed track is silent,
 * and the master gain is applied without re-normalising.
 *
 * ffmpeg-dependent cases (MP3, MP4, cancellation) skip cleanly when ffmpeg is
 * missing; everything else runs anywhere.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeWav, parseWav, peakOf, toDb, fromDb } from '../src/audio/wav.js'
import { findFfmpeg } from '../src/tools/shared.js'
import { renderProject, exportProject } from '../src/project/render.js'
import { writeMaterialIndex, saveProject } from '../src/project/store.js'
import { materialsDir, projectDir, videoDir } from '../src/project/paths.js'
import { emptyProject, defaultTrack, defaultItem, contentEndSec } from '../src/project/schema.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = join(root, '.anyaudio', 'test-tmp-render')
const workspaceRoot = join(scratch, 'workspace')
const SAMPLE_RATE = 48000

await rm(scratch, { recursive: true, force: true })
await mkdir(workspaceRoot, { recursive: true })

let passed = 0
let failed = 0
const step = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log('ok  ', name)
  } catch (error) {
    if (error?.skip) {
      console.log('skip', name, '—', error.skip)
      return
    }
    failed++
    console.log('FAIL', name, '—', error.message)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function near(actual, expected, tolerance, message) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected} ± ${tolerance}, got ${actual}`)
  }
}

/** A stereo material of constant amplitude so hand arithmetic stays exact. */
function constantTone(seconds, amplitude = 0.5, frequency = 100) {
  const frames = Math.round(seconds * SAMPLE_RATE)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * amplitude
    left[i] = value
    right[i] = value
  }
  return [left, right]
}

/**
 * Build a project folder by hand: one material per entry, tracks/items as given.
 * The renderer is a pure function of these two files, so the fixture is the test.
 */
async function makeProject({ id, materials, tracks, normalizeGainDb = 0, masterFaderDb = 0, video = null, save = true }) {
  const project = emptyProject({ id, name: id, sampleRate: SAMPLE_RATE })
  project.normalizeGainDb = normalizeGainDb
  project.masterFaderDb = masterFaderDb
  project.video = video
  project.tracks = tracks
  const dir = projectDir(workspaceRoot, id)
  await mkdir(materialsDir(workspaceRoot, id), { recursive: true })
  const index = { materials: [] }
  for (const [materialId, channels] of Object.entries(materials)) {
    await mkdir(materialsDir(workspaceRoot, id), { recursive: true })
    await writeFile(join(materialsDir(workspaceRoot, id), `${materialId}.wav`), encodeWav({ sampleRate: SAMPLE_RATE, channels, bitDepth: 16 }))
    index.materials.push({
      id: materialId,
      file: `materials/${materialId}.wav`,
      durationSec: channels[0].length / SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
      channels: channels.length,
      kind: 'imported',
      bytes: 1,
      source: { kind: 'imported', originalName: `${materialId}.wav`, originalFormat: 'wav', importedAt: '2026-11-06T00:00:00Z' },
    })
  }
  await writeMaterialIndex(workspaceRoot, id, index)
  // A project over the limits cannot be saved (the store validates), which is
  // exactly what the limit cases want to exercise through the renderer.
  if (save) await saveProject(workspaceRoot, project, { by: 'user', note: '' })
  return { project: readProjectFile(project), dir }
}

function readProjectFile(project) {
  // saveProject stamps durationSec from content, so mirror that here: the
  // renderer must agree with the file, not with the pre-save object.
  return { ...project, durationSec: contentEndSec(project) }
}

await step('a single clip is placed, trimmed and scaled exactly as written', async () => {
  const material = constantTone(4, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), startSec: 1, inSec: 0.5, outSec: 2.5, gainDb: 0 }] }
  const { project, dir } = await makeProject({ id: 'prj_single', materials: { mat_tone: material }, tracks: [track] })
  // Compare against the 16-bit file on disk, not the pre-encoding floats: the
  // encoder quantises, so the renderer's input is the stored material.
  const stored = parseWav(await readFile(join(dir, 'materials', 'mat_tone.wav')))
  const rendered = await renderProject({ project, workspaceRoot })
  assert(rendered.durationSec === 3, `the timeline should end at 1 + 2s of audio = 3s, got ${rendered.durationSec}`)
  near(rendered.channels[0][0], 0, 1e-6, 'the timeline must start silent')
  const at = Math.round(1.5 * SAMPLE_RATE)
  near(rendered.channels[0][at + 100], stored.channels[0][Math.round(0.5 * SAMPLE_RATE) + 100], 1e-6, 'clip audio should be the material slice')
  near(rendered.channels[0][Math.round(2.9 * SAMPLE_RATE)], 0, 1e-6, 'audio must stop at the clip end')
})

await step('clip gain and track gain add up in dB', async () => {
  const material = constantTone(2, 0.4)
  const track = { ...defaultTrack('trk_a', 'A'), volumeDb: -6, items: [{ ...defaultItem('itm_a', 'mat_tone'), startSec: 0, inSec: 0, outSec: 2, gainDb: -3.5 }] }
  const { project } = await makeProject({ id: 'prj_gain', materials: { mat_tone: material }, tracks: [track] })
  const rendered = await renderProject({ project, workspaceRoot })
  const expected = peakOf(material) * fromDb(-6 - 3.5)
  near(peakOf(rendered.channels), expected, 2e-3, 'clip -3.5 dB plus track -6 dB should give -9.5 dB')
})

await step('several clips on one track are placed independently', async () => {
  const material = constantTone(1, 0.5)
  const track = {
    ...defaultTrack('trk_a', 'A'),
    items: [
      { ...defaultItem('itm_1', 'mat_tone'), startSec: 0, inSec: 0, outSec: 1, gainDb: 0 },
      { ...defaultItem('itm_2', 'mat_tone'), startSec: 2, inSec: 0, outSec: 1, gainDb: -20 },
    ],
  }
  const { project } = await makeProject({ id: 'prj_multi', materials: { mat_tone: material }, tracks: [track] })
  const rendered = await renderProject({ project, workspaceRoot })
  assert(rendered.durationSec === 3, `two 1s clips at 0s and 2s end at 3s, got ${rendered.durationSec}`)
  const firstPeak = peakOf([rendered.channels[0].subarray(0, SAMPLE_RATE), rendered.channels[1].subarray(0, SAMPLE_RATE)])
  const secondPeak = peakOf([rendered.channels[0].subarray(2 * SAMPLE_RATE, 3 * SAMPLE_RATE), rendered.channels[1].subarray(2 * SAMPLE_RATE, 3 * SAMPLE_RATE)])
  near(firstPeak, 0.5, 1e-3, 'the first clip keeps its level')
  near(secondPeak, 0.5 * fromDb(-20), 1e-3, 'the -20 dB clip must be quieter on its own')
  assert(secondPeak > 0, 'the second clip must not be silent')
})

await step('a muted clip is skipped but the other clips on its track are not', async () => {
  const material = constantTone(1, 0.5)
  const track = {
    ...defaultTrack('trk_a', 'A'),
    items: [
      { ...defaultItem('itm_1', 'mat_tone'), startSec: 0, inSec: 0, outSec: 1, muted: true },
      { ...defaultItem('itm_2', 'mat_tone'), startSec: 1, inSec: 0, outSec: 1 },
    ],
  }
  const { project } = await makeProject({ id: 'prj_item_mute', materials: { mat_tone: material }, tracks: [track] })
  const rendered = await renderProject({ project, workspaceRoot })
  near(peakOf([rendered.channels[0].subarray(0, SAMPLE_RATE)]), 0, 1e-6, 'the muted clip must be silent')
  assert(peakOf([rendered.channels[0].subarray(SAMPLE_RATE, 2 * SAMPLE_RATE)]) > 0.4, 'the unmuted clip must still sound')
})

await step('a muted track is silent and the rest of the project is unaffected', async () => {
  const material = constantTone(1, 0.5)
  const muted = { ...defaultTrack('trk_muted', 'Muted'), muted: true, items: [{ ...defaultItem('itm_m', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const live = { ...defaultTrack('trk_live', 'Live'), items: [{ ...defaultItem('itm_l', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_track_mute', materials: { mat_tone: material }, tracks: [muted, live] })
  const rendered = await renderProject({ project, workspaceRoot })
  near(peakOf(rendered.channels), 0.5, 1e-3, 'only the live track should reach the mix')
})

await step('solo silences every other track', async () => {
  const material = constantTone(1, 0.5)
  const a = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1, gainDb: -6 }] }
  const b = { ...defaultTrack('trk_b', 'B'), solo: true, items: [{ ...defaultItem('itm_b', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_solo', materials: { mat_tone: material }, tracks: [a, b] })
  const rendered = await renderProject({ project, workspaceRoot })
  near(peakOf(rendered.channels), 0.5, 1e-3, 'solo must keep only track B')
})

await step('pan follows an equal-power law and centre is a bypass', async () => {
  const material = constantTone(1, 0.5)
  const centred = { ...defaultTrack('trk_c', 'C'), items: [{ ...defaultItem('itm_c', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project: centreProject } = await makeProject({ id: 'prj_pan_centre', materials: { mat_tone: material }, tracks: [centred] })
  const centredRender = await renderProject({ project: centreProject, workspaceRoot })
  near(peakOf(centredRender.channels), 0.5, 1e-3, 'a centred clip must not lose 3 dB')

  const panned = { ...defaultTrack('trk_p', 'P'), pan: -1, items: [{ ...defaultItem('itm_p', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project: panProject } = await makeProject({ id: 'prj_pan_left', materials: { mat_tone: material }, tracks: [panned] })
  const pannedRender = await renderProject({ project: panProject, workspaceRoot })
  near(peakOf([pannedRender.channels[1], pannedRender.channels[1]]), 0, 1e-6, 'hard left must silence the right channel')
  near(peakOf([pannedRender.channels[0], pannedRender.channels[0]]), 0.5, 1e-3, 'hard left keeps the left channel at full level')

  const half = { ...defaultTrack('trk_h', 'H'), pan: 0.5, items: [{ ...defaultItem('itm_h', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project: halfProject } = await makeProject({ id: 'prj_pan_half', materials: { mat_tone: material }, tracks: [half] })
  const halfRender = await renderProject({ project: halfProject, workspaceRoot })
  const angle = ((0.5 + 1) * Math.PI) / 4
  near(peakOf([halfRender.channels[0]]), 0.5 * Math.cos(angle), 2e-3, 'half-right left channel gain')
  near(peakOf([halfRender.channels[1]]), 0.5 * Math.sin(angle), 2e-3, 'half-right right channel gain')
})

await step('fades start at silence and reach full level', async () => {
  const material = constantTone(2, 0.5)
  const track = { ...defaultTrack('trk_f', 'F'), items: [{ ...defaultItem('itm_f', 'mat_tone'), inSec: 0, outSec: 2, fadeInSec: 0.5, fadeOutSec: 0.5 }] }
  const { project } = await makeProject({ id: 'prj_fade', materials: { mat_tone: material }, tracks: [track] })
  const rendered = await renderProject({ project, workspaceRoot })
  near(Math.abs(rendered.channels[0][0]), 0, 1e-4, 'a fade-in must start at zero')
  near(Math.abs(rendered.channels[0][rendered.frames - 1]), 0, 1e-4, 'a fade-out must end at zero')
  const middle = peakOf([rendered.channels[0].subarray(Math.round(0.9 * SAMPLE_RATE), Math.round(1.1 * SAMPLE_RATE))])
  near(middle, 0.5, 1e-3, 'between the fades the clip is at full level')
  // Sample a window, not a single sample: a 100 Hz tone crosses zero every 240
  // frames, so one sample at 0.25s can legitimately be silence.
  const quarter = peakOf([rendered.channels[0].subarray(Math.round(0.24 * SAMPLE_RATE), Math.round(0.26 * SAMPLE_RATE))])
  near(quarter, 0.5 * 0.5, 0.02, 'a 0.5s fade-in should be at about half gain a quarter of the way in')
})

await step('the master gain is applied and never re-normalised', async () => {
  const material = constantTone(1, 0.8)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const plain = await makeProject({ id: 'prj_plain', materials: { mat_tone: material }, tracks: [track] })
  const plainRender = await renderProject({ project: plain.project, workspaceRoot })
  near(plainRender.peakDb, Number(toDb(0.8).toFixed(2)), 0.1, 'with no gains the peak is the material peak')

  // The same project with a fader that pulls 5 dB down must be 5 dB quieter,
  // not pulled back to a normalised ceiling.
  const quiet = await makeProject({ id: 'prj_quiet', materials: { mat_tone: material }, tracks: [track], masterFaderDb: -5 })
  const quietRender = await renderProject({ project: quiet.project, workspaceRoot })
  near(quietRender.peakDb, plainRender.peakDb - 5, 0.15, 'the master fader must lower the peak by exactly 5 dB')
  near(quietRender.appliedGainDb, -5, 1e-9, 'appliedGainDb must report the fader value')

  // normalizeGainDb and masterFaderDb sum, and the result is not measured back.
  const both = await makeProject({ id: 'prj_both', materials: { mat_tone: material }, tracks: [track], normalizeGainDb: -2.5, masterFaderDb: -5 })
  const bothRender = await renderProject({ project: both.project, workspaceRoot })
  near(bothRender.peakDb, plainRender.peakDb - 7.5, 0.15, 'normalize + fader must sum')
  near(bothRender.appliedGainDb, -7.5, 1e-9, 'appliedGainDb must be the sum of both fields')
})

await step('a boost is applied without clipping the maths', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_boost', materials: { mat_tone: material }, tracks: [track], normalizeGainDb: 6 })
  const rendered = await renderProject({ project, workspaceRoot })
  near(peakOf(rendered.channels), 0.5 * fromDb(6), 2e-3, 'the renderer keeps the float value; only the WAV encoder clamps')
})

await step('the timeline length follows the last clip', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), startSec: 4.25, inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_length', materials: { mat_tone: material }, tracks: [track] })
  const rendered = await renderProject({ project, workspaceRoot })
  near(rendered.durationSec, 5.25, 1e-6, 'the timeline ends where the last clip ends')
})

await step('a video longer than the audio keeps the full picture length', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({
    id: 'prj_video_len',
    materials: { mat_tone: material },
    tracks: [track],
    video: { path: 'video/pic.mp4', durationSec: 6, locked: true },
  })
  const rendered = await renderProject({ project, workspaceRoot })
  near(rendered.durationSec, 6, 1e-6, 'the render must follow the 6s picture, not the 1s of audio')
  near(peakOf([rendered.channels[0].subarray(Math.round(3 * SAMPLE_RATE))]), 0, 1e-6, 'the empty part of the picture is silent')
})

await step('an empty project is refused with a clear message', async () => {
  const { project } = await makeProject({ id: 'prj_empty', materials: {}, tracks: [] })
  let message = ''
  try {
    await renderProject({ project, workspaceRoot })
  } catch (error) {
    message = error.message
  }
  assert(/empty/.test(message), `expected an "empty" error, got "${message}"`)
})

await step('a clip pointing at a missing material names the clip', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_ghost'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_ghost', materials: { mat_tone: material }, tracks: [track] })
  let message = ''
  try {
    await renderProject({ project, workspaceRoot })
  } catch (error) {
    message = error.message
  }
  assert(/mat_ghost/.test(message) && /not in the project index/.test(message), `expected a missing-material error naming mat_ghost, got "${message}"`)
})

await step('more than 20 tracks or 15 minutes is a schema error', async () => {
  const material = constantTone(1, 0.2)
  const many = Array.from({ length: 21 }, (_, index) => ({
    ...defaultTrack(`trk_${index}`, `T${index}`),
    items: [{ ...defaultItem(`itm_${index}`, 'mat_tone'), inSec: 0, outSec: 1 }],
  }))
  const { project: tooMany } = await makeProject({ id: 'prj_toomany', materials: { mat_tone: material }, tracks: many, save: false })
  let trackError = ''
  try {
    await renderProject({ project: tooMany, workspaceRoot })
  } catch (error) {
    trackError = error.message
  }
  assert(/at most 20 tracks/.test(trackError), `expected a track-limit error, got "${trackError}"`)

  const long = {
    ...defaultTrack('trk_long', 'Long'),
    items: [{ ...defaultItem('itm_long', 'mat_tone'), startSec: 890, inSec: 0, outSec: 20 }],
  }
  const { project: tooLong } = await makeProject({ id: 'prj_toolong', materials: { mat_tone: material }, tracks: [long], save: false })
  let durationError = ''
  try {
    await renderProject({ project: tooLong, workspaceRoot })
  } catch (error) {
    durationError = error.message
  }
  assert(/at most 15 minutes/.test(durationError), `expected a duration-limit error, got "${durationError}"`)
})

await step('the renderer agrees with the old anyaudio_mix on a plain mix', async () => {
  const material = constantTone(1, 0.4)
  const a = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1, gainDb: -3 }] }
  const b = { ...defaultTrack('trk_b', 'B'), items: [{ ...defaultItem('itm_b', 'mat_tone'), startSec: 0.5, inSec: 0, outSec: 0.5 }] }
  const { project, dir } = await makeProject({ id: 'prj_regress', materials: { mat_tone: material }, tracks: [a, b] })

  // Reference: the old mix path with normalisation disabled.
  const { parseWav: parse } = await import('../src/audio/wav.js')
  const resolved = await readFile(join(dir, 'materials', 'mat_tone.wav'))
  const reference = parse(resolved)
  const frames = Math.round(1 * SAMPLE_RATE)
  const expected = [new Float32Array(frames), new Float32Array(frames)]
  const gainA = fromDb(-3)
  for (let channel = 0; channel < 2; channel++) {
    for (let i = 0; i < frames; i++) {
      expected[channel][i] += reference.channels[channel][i] * gainA
      const offset = Math.round(0.5 * SAMPLE_RATE)
      if (i >= offset && i < offset + Math.round(0.5 * SAMPLE_RATE)) {
        expected[channel][i] += reference.channels[channel][i - offset]
      }
    }
  }
  const rendered = await renderProject({ project, workspaceRoot })
  assert(rendered.frames === expected[0].length, `frame count ${rendered.frames} vs reference ${expected[0].length}`)
  let worst = 0
  for (let channel = 0; channel < 2; channel++) {
    for (let i = 0; i < frames; i++) worst = Math.max(worst, Math.abs(rendered.channels[channel][i] - expected[channel][i]))
  }
  assert(worst < 2e-3, `the renderer should match the reference mix, worst sample error ${worst}`)
})

await step('a cancelled render stops before writing anything', async () => {
  const material = constantTone(2, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 2 }] }
  const { project } = await makeProject({ id: 'prj_cancel', materials: { mat_tone: material }, tracks: [track] })
  const controller = new AbortController()
  controller.abort()
  let message = ''
  try {
    await renderProject({ project, workspaceRoot, signal: controller.signal })
  } catch (error) {
    message = error.message
  }
  assert(/cancelled/.test(message), `expected a cancellation error, got "${message}"`)
})

await step('export writes a WAV and a cancelled export leaves no file', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_export', materials: { mat_tone: material }, tracks: [track] })
  const out = join(scratch, 'out', 'render.wav')
  const result = await exportProject({ project, workspaceRoot, outputPath: out, format: 'wav' })
  assert(result.format === 'wav', 'format should be reported')
  const written = parseWav(await readFile(out))
  near(written.durationSec, 1, 0.01, 'the exported WAV should be one second long')

  const controller = new AbortController()
  controller.abort()
  const aborted = join(scratch, 'out', 'aborted.wav')
  let failedAsExpected = false
  try {
    await exportProject({ project, workspaceRoot, outputPath: aborted, format: 'wav', signal: controller.signal })
  } catch (error) {
    failedAsExpected = /cancelled/.test(error.message)
  }
  assert(failedAsExpected, 'a cancelled export must report cancellation')
  let exists = true
  try {
    await readFile(aborted)
  } catch {
    exists = false
  }
  assert(!exists, 'a cancelled export must leave no partial file')
})

await step('MP4 export keeps the picture length when the audio is shorter', async () => {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw { skip: 'ffmpeg is not installed' }
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({
    id: 'prj_mp4',
    materials: { mat_tone: material },
    tracks: [track],
    video: { path: 'video/pic.mp4', durationSec: 3, locked: true },
  })
  const dir = projectDir(workspaceRoot, 'prj_mp4')
  await mkdir(videoDir(workspaceRoot, 'prj_mp4'), { recursive: true })
  const videoPath = join(dir, 'video', 'pic.mp4')
  const spawn = (await import('node:child_process')).spawn
  await new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg.command, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=navy:s=64x64:d=3:r=10',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath,
    ], { windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`fixture mp4 failed with ${code}`))))
  })

  const out = join(scratch, 'out', 'project.mp4')
  await exportProject({ project, workspaceRoot, outputPath: out, format: 'mp4' })
  const { probeDuration } = await import('../src/tools/mix.js')
  const duration = await probeDuration(ffmpeg.command, out)
  near(duration, 3, 0.2, 'the MP4 must keep the 3s picture even though the project audio is 1s')
})

await step('MP3 export produces a playable file', async () => {
  if (!findFfmpeg()) throw { skip: 'ffmpeg is not installed' }
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_mp3', materials: { mat_tone: material }, tracks: [track] })
  const out = join(scratch, 'out', 'project.mp3')
  await exportProject({ project, workspaceRoot, outputPath: out, format: 'mp3' })
  const bytes = await readFile(out)
  assert(bytes.length > 1000, `the MP3 looks empty (${bytes.length} bytes)`)
  // The intermediate WAV must not be left behind.
  let leftovers = []
  try {
    leftovers = await (await import('node:fs/promises')).readdir(join(scratch, 'out'))
  } catch {
    leftovers = []
  }
  assert(!leftovers.some((name) => name.includes('.render.wav')), `a scratch WAV was left behind: ${leftovers.join(', ')}`)
})

await step('MP4 export without a video is refused', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_novideo', materials: { mat_tone: material }, tracks: [track] })
  let message = ''
  try {
    await exportProject({ project, workspaceRoot, outputPath: join(scratch, 'out', 'nope.mp4'), format: 'mp4' })
  } catch (error) {
    message = error.message
  }
  assert(/no video/.test(message), `expected a "no video" error, got "${message}"`)
})

await step('export does not re-normalise the mix unless asked', async () => {
  // spec §10.2 / §15 step 9: the gain the person dialled in has to survive the
  // export. Without the explicit switch a quiet mix stays quiet.
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({
    id: 'prj_normalize',
    materials: { mat_tone: material },
    tracks: [track],
    masterFaderDb: -12,
  })
  const plain = join(scratch, 'out', 'plain.wav')
  const plainResult = await exportProject({ project, workspaceRoot, outputPath: plain, format: 'wav' })
  const plainWav = parseWav(await readFile(plain))
  near(toDb(peakOf(plainWav.channels)), plainResult.peakDb, 0.1, 'the reported peak should match the file')
  assert(toDb(peakOf(plainWav.channels)) < -10, `the -12 dB fader must not be pulled back up (peak ${toDb(peakOf(plainWav.channels))} dB)`)

  const loud = join(scratch, 'out', 'loud.wav')
  const loudResult = await exportProject({ project, workspaceRoot, outputPath: loud, format: 'wav', normalize: true })
  const loudWav = parseWav(await readFile(loud))
  near(toDb(peakOf(loudWav.channels)), -1.5, 0.2, 'optionally normalised exports peak at -1.5 dBFS')
  near(loudResult.peakDb, -1.5, 0.2, 'the reported peak should follow the normalisation')
})

await step('an unknown export format is refused', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project } = await makeProject({ id: 'prj_badformat', materials: { mat_tone: material }, tracks: [track] })
  let message = ''
  try {
    await exportProject({ project, workspaceRoot, outputPath: join(scratch, 'out', 'x.ogg'), format: 'ogg' })
  } catch (error) {
    message = error.message
  }
  assert(/unknown export format/.test(message), `expected a format error, got "${message}"`)
})

await step('the project file on disk is not modified by rendering', async () => {
  const material = constantTone(1, 0.5)
  const track = { ...defaultTrack('trk_a', 'A'), items: [{ ...defaultItem('itm_a', 'mat_tone'), inSec: 0, outSec: 1 }] }
  const { project, dir } = await makeProject({ id: 'prj_pure', materials: { mat_tone: material }, tracks: [track] })
  const before = await readFile(join(dir, 'project.json'), 'utf8')
  await renderProject({ project, workspaceRoot })
  const after = await readFile(join(dir, 'project.json'), 'utf8')
  assert(before === after, 'rendering must be a pure read of project.json')
})

console.log(`\n${passed} passed, ${failed} failed`)
await rm(scratch, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
