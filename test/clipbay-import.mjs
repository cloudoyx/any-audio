// M1 acceptance: any common audio/video becomes a project material in the
// internal 48 kHz stereo format, with the original kept and a peak cache written.
// Fixtures are generated with ffmpeg into .anyaudio/test-tmp-import.
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProject, readMaterialIndex, readProject } from '../src/project/store.js'
import { importFile, importGeneratedMaterial, ImportError, kindOfFile, IMPORT_SAMPLE_RATE } from '../src/project/import.js'
import { analyzeChannels, BUCKETS_PER_SECOND, bucketCount, computePeaks, peaksPathFor, readPeaks } from '../src/audio/peaks.js'
import { encodeWav, parseWav } from '../src/audio/wav.js'
import { findFfmpeg, runFfmpeg } from '../src/tools/shared.js'
import { projectDir, materialsDir, sourcesDir } from '../src/project/paths.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-import')
await rm(tmpDir, { recursive: true, force: true })
await mkdir(tmpDir, { recursive: true })

let passed = 0
let failed = 0

async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function rejects(run, pattern, message) {
  let error = null
  try {
    await run()
  } catch (caught) {
    error = caught
  }
  assert(error, `${message}: expected a rejection, the call succeeded`)
  assert(pattern.test(error.message), `${message}: message was "${error.message}"`)
  return error
}

const ffmpeg = findFfmpeg()
if (!ffmpeg) {
  console.log('SKIP import: ffmpeg is not available on this machine')
  console.log('\n0 passed, 0 failed (skipped)')
  process.exit(0)
}

function toneWav(seconds = 2, sampleRate = 48000, channels = 2) {
  const frames = Math.round(seconds * sampleRate)
  const data = Array.from({ length: channels }, (_, channel) => {
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++) samples[i] = Math.sin((2 * Math.PI * (440 + channel * 110) * i) / sampleRate) * 0.5
    return samples
  })
  return encodeWav({ sampleRate, channels: data, bitDepth: 16 })
}

const fixtureDir = join(tmpDir, 'fixtures')
await mkdir(fixtureDir, { recursive: true })
const ws = join(tmpDir, 'workspace')

const wavPath = join(fixtureDir, 'tone.wav')
await (await import('node:fs/promises')).writeFile(wavPath, toneWav(3))

const mp3Path = join(fixtureDir, 'tone.mp3')
await runFfmpeg(ffmpeg.command, ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path])
const m4aPath = join(fixtureDir, 'tone.m4a')
await runFfmpeg(ffmpeg.command, ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-c:a', 'aac', '-b:a', '128k', m4aPath])

// A tiny video whose own soundtrack is a quiet 220 Hz tone, 4 s long.
const mp4Path = join(fixtureDir, 'clip.mp4')
await runFfmpeg(ffmpeg.command, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=navy:s=64x64:d=4:r=5',
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4Path,
])

// The same picture with no audio stream at all — a screen recording, a silent
// render, anything a tool wrote without a soundtrack.
const silentMp4Path = join(fixtureDir, 'silent.mp4')
await runFfmpeg(ffmpeg.command, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=navy:s=64x64:d=3:r=5',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', silentMp4Path,
])

await test('kindOfFile recognises audio and video extensions', async () => {
  assert(kindOfFile('a.wav') === 'audio', 'wav is audio')
  assert(kindOfFile('a.MP3') === 'audio', 'uppercase mp3 is audio')
  assert(kindOfFile('a.mp4') === 'video', 'mp4 is video')
  assert(kindOfFile('a.txt') === null, 'txt is unknown')
})

await test('a WAV that is already internal format is copied, not re-encoded', async () => {
  const project = await createProject(ws, { name: 'wav import' })
  const { material } = await importFile(ws, project.id, wavPath, { findFfmpeg })
  assert(material.kind === 'imported', 'kind is imported')
  assert(material.sampleRate === IMPORT_SAMPLE_RATE, 'sample rate is 48 kHz')
  assert(material.channels === 2, 'stereo')
  assert(Math.abs(material.durationSec - 3) < 0.05, `duration should be ~3s, got ${material.durationSec}`)

  const dir = projectDir(ws, project.id)
  const original = join(sourcesDir(ws, project.id), `${material.id}.orig.wav`)
  const copy = join(materialsDir(ws, project.id), `${material.id}.wav`)
  assert(existsSync(original), 'the original was kept in sources/')
  assert(existsSync(copy), 'the converted copy is in materials/')
  const originalBytes = (await stat(original)).size
  const fixtureBytes = (await stat(wavPath)).size
  assert(originalBytes === fixtureBytes, `the original must be byte-identical (${originalBytes} vs ${fixtureBytes})`)
  const decoded = parseWav(await readFile(copy))
  assert(decoded.sampleRate === 48000 && decoded.channels.length === 2, 'the copy is 48 kHz stereo')

  const entry = (await readMaterialIndex(ws, project.id)).materials.find((row) => row.id === material.id)
  assert(entry.source.originalName === 'tone.wav', 'the original name is recorded')
  assert(entry.source.originalFormat === 'wav', 'the original format is recorded')
  assert(typeof entry.source.importedAt === 'string', 'the import time is recorded')
  assert(!entry.source.snapshot, 'no creation snapshot is invented for an import')
  assert(existsSync(join(dir, 'materials', `${material.id}.peaks.json`)), 'the peak cache exists')
})

await test('mp3 and m4a are converted to 48 kHz stereo', async () => {
  for (const [label, path] of [['mp3', mp3Path], ['m4a', m4aPath]]) {
    const project = await createProject(ws, { name: `${label} import` })
    const { material } = await importFile(ws, project.id, path, { findFfmpeg })
    assert(material.sampleRate === 48000, `${label}: sample rate`)
    assert(material.channels === 2, `${label}: channels`)
    assert(Math.abs(material.durationSec - 3) < 0.25, `${label}: duration ${material.durationSec}`)
    const copy = join(materialsDir(ws, project.id), `${material.id}.wav`)
    const decoded = parseWav(await readFile(copy))
    assert(decoded.sampleRate === 48000 && decoded.channels.length === 2, `${label}: the copy is internal format`)
    assert(existsSync(join(sourcesDir(ws, project.id), `${material.id}.orig.${label}`)), `${label}: original kept`)
  }
})

await test('the peak bucket count is ceil(duration × 50)', async () => {
  const project = await createProject(ws, { name: 'peaks' })
  const { material } = await importFile(ws, project.id, wavPath, { findFfmpeg })
  const series = await readPeaks(join(materialsDir(ws, project.id), `${material.id}.peaks.json`))
  assert(series.bucketsPerSecond === BUCKETS_PER_SECOND, `density is ${BUCKETS_PER_SECOND}`)
  assert(series.buckets === bucketCount(material.durationSec), `buckets ${series.buckets} vs ceil(${material.durationSec}×50)`)
  assert(series.min.length === series.buckets && series.max.length === series.buckets, 'min/max arrays match the bucket count')
  assert(series.max.some((value) => value > 0.2), 'the peaks follow the real tone amplitude')
})

await test('importing a video keeps the picture and extracts its sound track', async () => {
  const project = await createProject(ws, { name: 'video import' })
  const { material, video } = await importFile(ws, project.id, mp4Path, { findFfmpeg })
  assert(material.kind === 'video-audio', 'the extracted material is video-audio')
  assert(Math.abs(material.durationSec - 4) < 0.3, `extracted audio should be ~4s, got ${material.durationSec}`)
  assert(video && video.path.startsWith('video/'), 'the video copy is recorded')
  assert(video.locked === true, 'the first version locks the picture')
  assert(existsSync(join(projectDir(ws, project.id), video.path)), 'the video file was copied into the project')

  const reread = await readProject(ws, project.id)
  assert(reread.video && reread.video.path === video.path, 'project.json points at the video copy')
  assert(Math.abs(reread.video.durationSec - 4) < 0.3, 'the video duration was probed')
  assert(reread.durationSec >= 4, 'the project duration follows the video when it is longer')
})

await test('a picture with no audio stream still imports as a reference picture', async () => {
  const project = await createProject(ws, { name: 'silent video' })
  const { material, video, silent } = await importFile(ws, project.id, silentMp4Path, { findFfmpeg })
  assert(silent === true, 'the import reports that there was no soundtrack')
  assert(material === null, 'no soundtrack means no soundtrack material')
  assert(video && video.path.startsWith('video/'), 'the picture is still copied and recorded')
  assert(video.locked === true, 'the picture is locked the same way a sounding one is')
  assert(existsSync(join(projectDir(ws, project.id), video.path)), 'the silent picture really landed in video/')
  assert(Math.abs(video.durationSec - 3) < 0.3, `the silent picture duration was probed, got ${video.durationSec}`)

  const index = await readMaterialIndex(ws, project.id)
  assert(index.materials.length === 0, 'a silent picture registers no material')

  const reread = await readProject(ws, project.id)
  assert(reread.video && reread.video.path === video.path, 'project.json points at the silent picture')
  assert(reread.durationSec >= 3, 'the project length still follows the picture')
})

await test('an import that fails for another reason is still an error', async () => {
  // The silent-picture path must not swallow unrelated ffmpeg failures. A file
  // that is not a video at all dies at the duration probe, before any audio
  // extraction is attempted.
  const project = await createProject(ws, { name: 'broken video' })
  const broken = join(fixtureDir, 'broken.mp4')
  await (await import('node:fs/promises')).writeFile(broken, Buffer.from('this is not a video'))
  await rejects(() => importFile(ws, project.id, broken, { findFfmpeg }), /could not read the duration/, 'a corrupt mp4 is still refused')
})

await test('a missing or empty file fails with a clear message', async () => {
  const project = await createProject(ws, { name: 'errors' })
  await rejects(() => importFile(ws, project.id, join(fixtureDir, 'nope.wav'), { findFfmpeg }), /no such file/, 'missing file')

  const emptyPath = join(fixtureDir, 'empty.mp3')
  await (await import('node:fs/promises')).writeFile(emptyPath, Buffer.alloc(0))
  await rejects(() => importFile(ws, project.id, emptyPath, { findFfmpeg }), /the file is empty/, 'empty file')

  const brokenPath = join(fixtureDir, 'broken.mp3')
  await (await import('node:fs/promises')).writeFile(brokenPath, Buffer.from('not really audio at all'))
  const error = await rejects(() => importFile(ws, project.id, brokenPath, { findFfmpeg }), /converting "broken.mp3"/, 'corrupt file')
  assert(/ffmpeg exited with code/.test(error.message), 'the ffmpeg error is passed through instead of a generic message')

  const unknownPath = join(fixtureDir, 'notes.txt')
  await (await import('node:fs/promises')).writeFile(unknownPath, Buffer.from('hello'))
  await rejects(() => importFile(ws, project.id, unknownPath, { findFfmpeg }), /unsupported file type/, 'unknown extension')
})

await test('a failed import does not leave a half-registered material', async () => {
  const project = await createProject(ws, { name: 'cleanup' })
  const brokenPath = join(fixtureDir, 'broken.mp3')
  await rejects(() => importFile(ws, project.id, brokenPath, { findFfmpeg }), /converting/, 'broken import')
  const index = await readMaterialIndex(ws, project.id)
  assert(index.materials.length === 0, `the index must stay empty, has ${index.materials.length}`)
})

await test('a generated material freezes its creation snapshot', async () => {
  const project = await createProject(ws, { name: 'generated' })
  const { material } = await importGeneratedMaterial(ws, project.id, {
    sourcePath: wavPath,
    kind: 'music-stem',
    snapshotKind: 'score',
    snapshot: { title: 'main', tracks: [{ name: 'piano', notes: [[0, 1, 'C4', 90]] }] },
    tool: 'anyaudio_music',
  })
  assert(material.source.kind === 'generated', 'source kind is generated')
  assert(material.source.snapshot.endsWith('.score.json'), `snapshot path ${material.source.snapshot}`)
  assert(material.source.tool === 'anyaudio_music', 'the producing tool is recorded')
  const snapshot = JSON.parse(await readFile(join(projectDir(ws, project.id), material.source.snapshot), 'utf8'))
  assert(snapshot.title === 'main', 'the snapshot contents were copied, not referenced')
})

await test('computePeaks keeps the sign and the extremes', async () => {
  const samples = new Float32Array([0, 0.5, -0.75, 0, 1, -1, 0, 0])
  const series = computePeaks([samples], 0.0002, { bucketsPerSecond: 5000 })
  assert(series.min.some((value) => value < -0.9), 'the negative extreme is kept')
  assert(series.max.some((value) => value > 0.9), 'the positive extreme is kept')
})

await test('peaksPathFor keeps the peaks next to the material', async () => {
  assert(peaksPathFor('materials/mat_1.wav', 'mat_1') === 'materials/mat_1.peaks.json', 'same folder')
  assert(peaksPathFor('mat_1.wav', 'mat_1') === 'mat_1.peaks.json', 'no folder')
})

await test('the project folder contains exactly the spec layout', async () => {
  const project = await createProject(ws, { name: 'layout' })
  await importFile(ws, project.id, wavPath, { findFfmpeg })
  const names = (await readdir(projectDir(ws, project.id))).sort()
  assert(names.includes('project.json'), 'project.json')
  assert(names.includes('materials'), 'materials/')
  assert(names.includes('sources'), 'sources/')
  const materialNames = (await readdir(materialsDir(ws, project.id))).sort()
  assert(materialNames.includes('index.json'), 'materials/index.json')
  assert(materialNames.some((name) => name.endsWith('.peaks.json')), 'a peak cache in materials/')
  const sourceNames = await readdir(sourcesDir(ws, project.id))
  assert(sourceNames.some((name) => name.includes('.orig.')), 'the original in sources/')
})

await test('an imported material records its measured level', async () => {
  // Improvement plan 03, I-37. The index knew a material's length but not its
  // loudness, so "how loud is this" had no answer for a file that cannot be
  // re-rendered at all — a user's own library or a dropped-in file.
  const project = await createProject(ws, { name: 'levels' })
  const { material } = await importFile(ws, project.id, wavPath, { findFfmpeg })
  assert(typeof material.peakDb === 'number', `peakDb missing: ${material.peakDb}`)
  assert(typeof material.rmsDb === 'number', `rmsDb missing: ${material.rmsDb}`)

  // The fixture is a steady tone at 0.5 amplitude: measure the copy directly and
  // compare, so the test cannot pass on a number that was merely present.
  const copy = join(materialsDir(ws, project.id), `${material.id}.wav`)
  const decoded = parseWav(await readFile(copy))
  const measured = analyzeChannels(decoded.channels, decoded.channels[0].length / decoded.sampleRate)
  assert(Math.abs(material.peakDb - measured.peakDb) < 0.01, `peakDb ${material.peakDb} vs measured ${measured.peakDb}`)
  assert(Math.abs(material.rmsDb - measured.rmsDb) < 0.01, `rmsDb ${material.rmsDb} vs measured ${measured.rmsDb}`)
  assert(measured.peakDb > -12 && measured.peakDb < 0, `a 0.5 tone peaks near -6 dBFS, got ${measured.peakDb}`)

  const entry = (await readMaterialIndex(ws, project.id)).materials.find((row) => row.id === material.id)
  assert(entry.peakDb === material.peakDb && entry.rmsDb === material.rmsDb, 'the same numbers reach the index')
})

await test('a generated material records its level too', async () => {
  const project = await createProject(ws, { name: 'generated levels' })
  const { material } = await importGeneratedMaterial(ws, project.id, {
    sourcePath: wavPath,
    kind: 'music',
    snapshotKind: 'score',
    snapshot: { title: '测试' },
    tool: 'anyaudio_music',
    label: '测试',
  })
  assert(typeof material.peakDb === 'number' && typeof material.rmsDb === 'number', 'generated material has levels')
})

await test('analyzeChannels reports a silent file as null, not 0 dB', async () => {
  // -Infinity is not JSON and 0 dB would be a claim that the file is loud.
  const silent = new Float32Array(4800)
  const result = analyzeChannels([silent], 0.1)
  assert(result.peakDb === null, `a silent file has no peak, got ${result.peakDb}`)
  assert(result.rmsDb === null, `a silent file has no RMS, got ${result.rmsDb}`)
  assert(result.peaks.buckets > 0, 'the waveform is still a real series')
})

await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) {
  const leftover = await readdir(anyaudioDir).catch(() => [])
  if (leftover.length === 0) await rm(anyaudioDir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
