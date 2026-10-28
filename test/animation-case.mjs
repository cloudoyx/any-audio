#!/usr/bin/env node
/**
 * Real-case test: score and mix the existing 《愚公移山》 short film without
 * touching the source project. Reads its timing/narration files, renders a
 * new instrumental score, ducks it under the narration and muxes a new MP4
 * into this repository's .anyaudio output directory.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { encodeWav, parseWav, peakOf, rmsOf, toDb } from '../src/audio/wav.js'
import { registerAllTools } from '../src/tools/index.js'
import { findFfmpeg, runFfmpeg } from '../src/tools/shared.js'

const animationDir = 'D:\\animation'
const repoRoot = resolve('.')
const outDir = join(repoRoot, '.anyaudio', 'out', 'animation-case')
const excerptDir = join(outDir, 'excerpts')
const exec = { agent: { workspaceRoot: repoRoot } }
const tools = new Map()
registerAllTools({
  tools: { register: (definition) => tools.set(definition.name, definition) },
  logger: { info: () => {} },
  get: () => undefined,
})

const timing = JSON.parse(await readFile(join(animationDir, 'build', 'timing.json'), 'utf8'))
const narration = JSON.parse(await readFile(join(animationDir, 'build', 'audio', 'narration.json'), 'utf8'))
const total = timing.total
const marks = timing.marks
const sections = [
  { key: 'A', start: marks.A, end: marks.B, intensity: 0.42, lead: 'koto', pad: ['D3', 'A3'], bass: 'D2', name: 'open' },
  { key: 'B', start: marks.B, end: marks.C, intensity: 0.55, lead: 'koto', pad: ['B2', 'F#3'], bass: 'D2', name: 'resolve' },
  { key: 'C', start: marks.C, end: marks.D, intensity: 0.34, lead: 'xiao', pad: ['D3', 'A3'], bass: 'D2', name: 'doubt' },
  { key: 'D', start: marks.D, end: marks.E, intensity: 0.52, lead: 'guzheng', pad: ['E3', 'B3'], bass: 'F#2', name: 'answer' },
  { key: 'E', start: marks.E, end: marks.F, intensity: 0.7, lead: 'guzheng', pad: ['D3', 'A3'], bass: 'D2', name: 'labor' },
  { key: 'F', start: marks.F, end: marks.G, intensity: 1, lead: 'koto', pad: ['D3', 'A3', 'D4'], bass: 'D2', name: 'miracle' },
  { key: 'G', start: marks.G, end: total, intensity: 0.3, lead: 'xiao', pad: ['D3', 'A3'], bass: 'D2', name: 'close' },
]

const phrases = {
  A: [[0, 1.0, 'D4', 86], [1.0, 0.5, 'A3', 72], [1.5, 0.5, 'D4', 78], [2.0, 1.5, 'F#4', 88], [3.5, 1.0, 'E4', 74], [4.5, 2.5, 'D4', 80], [7.0, 1.2, 'A3', 70], [8.2, 2.2, 'D4', 76]],
  B: [[0, 0.75, 'A4', 82], [0.75, 0.75, 'B4', 86], [1.5, 1.2, 'D5', 94], [2.7, 0.75, 'E5', 88], [3.45, 1.5, 'D5', 84], [4.95, 1.0, 'B4', 78], [5.95, 2.0, 'A4', 76], [8.0, 0.9, 'F#4', 74], [8.9, 2.0, 'E4', 72]],
  C: [[0, 1.5, 'D4', 66], [1.5, 1.0, 'E4', 62], [2.5, 2.0, 'F#4', 70], [4.5, 1.0, 'E4', 60], [5.5, 3.0, 'D4', 64], [8.5, 1.5, 'A3', 58]],
  D: [[0, 1.0, 'A3', 76], [1.0, 1.0, 'D4', 82], [2.0, 1.5, 'F#4', 90], [3.5, 1.5, 'A4', 92], [5.0, 2.0, 'B4', 88], [7.0, 1.5, 'A4', 82], [8.5, 1.5, 'D4', 78]],
  E: [[0, 0.5, 'D4', 84], [0.5, 0.5, 'A3', 74], [1.0, 0.5, 'D4', 84], [1.5, 0.5, 'F#4', 88], [2.0, 0.5, 'D4', 82], [2.5, 0.5, 'A3', 72], [3.0, 0.5, 'B3', 80], [3.5, 0.5, 'D4', 86], [6.0, 0.5, 'D5', 92], [6.5, 0.5, 'B4', 84], [7.0, 0.5, 'A4', 80], [7.5, 0.5, 'F#4', 84], [8.0, 0.5, 'E4', 78], [8.5, 0.5, 'D4', 82], [9.0, 1.5, 'A3', 76], [11.0, 1.2, 'D4', 84]],
  F: [[0, 1.0, 'D4', 96], [1.0, 0.5, 'E4', 92], [1.5, 0.5, 'F#4', 96], [2.0, 0.5, 'A4', 100], [2.5, 0.5, 'B4', 100], [3.0, 0.5, 'D5', 104], [3.5, 0.75, 'E5', 106], [4.25, 0.75, 'F#5', 108], [5.0, 1.0, 'A5', 110], [6.0, 1.0, 'D5', 98], [7.0, 1.0, 'A4', 94], [8.0, 2.0, ['D4', 'A4', 'D5'], 96], [10.5, 1.0, 'D5', 90], [11.5, 2.5, 'D4', 84]],
  G: [[0, 2.0, 'A4', 62], [2.0, 2.5, 'D4', 58], [4.5, 2.0, 'B3', 54], [6.5, 3.0, 'A3', 50], [9.5, 2.5, 'D3', 48]],
}

function buildScore() {
  const lead = []
  const pad = []
  const bass = []
  const drums = []
  const bells = []
  for (const section of sections) {
    const base = section.start
    const span = section.end - section.start
    for (const [offset, duration, pitch, velocity] of phrases[section.key]) {
      if (offset >= span - 0.05) continue
      lead.push([Number((base + offset).toFixed(3)), duration, pitch, velocity])
    }
    pad.push([Number(base.toFixed(3)), Number((span - 0.05).toFixed(3)), section.pad, Math.round(52 + 26 * section.intensity)])
    const bassCount = section.key === 'E' ? 4 : section.key === 'F' ? 2 : 1
    for (let i = 0; i < bassCount; i++) {
      const length = (span - 0.1) / bassCount
      bass.push([Number((base + i * length).toFixed(3)), Number((length * 0.96).toFixed(3)), section.bass, Math.round(62 + 22 * section.intensity)])
    }
    drums.push([Number(base.toFixed(3)), 0.25, 'taiko', Math.round(70 + 30 * section.intensity)])
    if (section.key === 'E') {
      for (let t = 3; t < span - 0.4; t += 3) drums.push([Number((base + t).toFixed(3)), 0.25, 'taiko', 78])
    }
    if (section.key === 'F') {
      drums.push([Number((base + 8.5).toFixed(3)), 0.3, 'gong', 104])
      for (let t = 1.5; t < span - 0.5; t += 1.5) drums.push([Number((base + t).toFixed(3)), 0.2, 'taiko', 92])
      for (let t = 6; t < span - 0.5; t += 0.75) drums.push([Number((base + t).toFixed(3)), 0.15, 'snare', 78])
      bells.push([Number((base + 3.5).toFixed(3)), 1.5, 'A5', 88], [Number((base + 8.5).toFixed(3)), 2.0, 'D5', 84])
    }
  }
  return {
    title: '愚公移山 · AnyAudio score',
    tracks: [
      { name: 'lead', instrument: 'koto', gainDb: -2, pan: 0.08, reverb: 0.4, humanize: { timingMs: 7, velocity: 5, seed: 11 }, notes: lead },
      { name: 'pad', instrument: 'slow-strings', gainDb: -14, pan: 0, reverb: 0.55, notes: pad },
      { name: 'bass', instrument: 'cello', gainDb: -9, pan: -0.05, reverb: 0.25, notes: bass },
      { name: 'percussion', instrument: 'drums', drums: true, gainDb: -11, reverb: 0.3, notes: drums },
      { name: 'bells', instrument: 'glockenspiel', gainDb: -16, pan: 0.35, reverb: 0.6, notes: bells },
    ],
  }
}

const report = []
const log = (line) => {
  report.push(line)
  console.log(line)
}

await mkdir(excerptDir, { recursive: true })
log(`# 愚公移山 real-case run (${new Date().toISOString()})`)
log(`source: ${animationDir}, length ${total}s, ${timing.subs.length} narration lines`)

const sourcesTool = tools.get('anyaudio_sources')
const defaultFont = await sourcesTool.execute({ action: 'use' }, exec)
log(`font: ${defaultFont.font}`)

const score = buildScore()
log(`score: ${score.tracks.map((track) => `${track.name}(${track.instrument}, ${track.notes.length})`).join(', ')}`)

const renderStart = Date.now()
const music = await tools.get('anyaudio_music').execute(
  { score, durationSec: total, output: join(outDir, 'music.wav') },
  exec,
)
log(`music: ${music.file} ${music.durationSec}s peak ${music.peakDb} dBFS, rendered in ${((Date.now() - renderStart) / 1000).toFixed(1)}s`)
for (const warning of music.warnings) log(`  warning: ${warning}`)

const sfx = await tools.get('anyaudio_sfx').execute(
  {
    items: [
      { type: 'wind', startSec: 0, durationSec: total, gainDb: -30, params: { intensity: 0.45, gustRate: 0.25 } },
      { type: 'stones', startSec: 45.0, durationSec: 4, gainDb: -18, params: { intensity: 0.5 } },
      { type: 'whoosh', startSec: 56.2, durationSec: 1.6, gainDb: -12, params: { brightness: 0.7 } },
      { type: 'impact', startSec: total - 1.5, durationSec: 1.5, gainDb: -14, params: { weight: 0.8 } },
    ],
    durationSec: total,
    output: join(outDir, 'sfx.wav'),
  },
  exec,
)
log(`sfx: ${sfx.file} ${sfx.durationSec}s peak ${sfx.peakDb} dBFS`)

const tracks = [
  ...narration.map((line) => ({
    role: 'narration',
    path: join(animationDir, 'build', 'audio', 'nar', `${line.id}.wav`),
    offsetSec: timing.subs.find((sub) => sub.id === line.id)?.start ?? 0,
    gainDb: 0,
  })),
  { role: 'music', path: music.absolutePath, gainDb: -5, fadeInSec: 1.2, fadeOutSec: 3.5 },
  { role: 'sfx', path: sfx.absolutePath, gainDb: -6 },
]

const ffmpeg = findFfmpeg()
if (!ffmpeg) log('ffmpeg: not found — the MP4 step will fail, the WAV will still be produced')
else log(`ffmpeg: ${ffmpeg.version}`)

const mix = await tools.get('anyaudio_mix').execute(
  {
    tracks,
    durationSec: total,
    output: join(outDir, '愚公移山-anyaudio.wav'),
    video: join(animationDir, 'output', '愚公移山.mp4'),
    videoOutput: join(outDir, '愚公移山-anyaudio.mp4'),
    ducking: { targetDb: -10, thresholdDb: -40 },
  },
  exec,
)
log(`mix: ${mix.file} ${mix.durationSec}s peak ${mix.peakDb} dBFS rms ${mix.rmsDb} dBFS`)
log(`ducking: ${JSON.stringify(mix.ducking)}`)
log(`track levels: ${mix.tracks.map((track) => `${track.role}#${track.offsetSec}s ${track.rmsDb}dB`).join(', ')}`)
log(`mux: ${JSON.stringify(mix.mux)}`)
for (const warning of mix.warnings) log(`  warning: ${warning}`)

// --- objective comparison against the original NumPy mix ---
function analyse(channels, sampleRate, label, narrationWindows) {
  let clipped = 0
  for (const channel of channels) for (const value of channel) if (Math.abs(value) >= 1) clipped++
  const windows = narrationWindows.map(([start, end]) => {
    const a = Math.floor(start * sampleRate)
    const b = Math.min(channels[0].length, Math.floor(end * sampleRate))
    let sum = 0
    for (let i = a; i < b; i++) sum += channels[0][i] * channels[0][i] + channels[1][i] * channels[1][i]
    return toDb(Math.sqrt(sum / Math.max(1, (b - a) * 2)))
  })
  return {
    label,
    durationSec: channels[0].length / sampleRate,
    peakDb: toDb(peakOf(channels)),
    rmsDb: toDb(rmsOf(channels)),
    clipped,
    narrationWindowRmsDb: windows,
  }
}

const mixedWav = parseWav(await readFile(mix.absolutePath))
const originalWav = parseWav(await readFile(join(animationDir, 'build', 'audio', 'mix.wav')))
const numpyMusicWav = parseWav(await readFile(join(animationDir, 'build', 'audio', 'music.wav')))
const narrationWindows = timing.subs.map((sub) => [sub.start, sub.end])

const newStats = analyse(mixedWav.channels, mixedWav.sampleRate, 'anyaudio mix', narrationWindows)
const oldStats = analyse(originalWav.channels, originalWav.sampleRate, 'original numpy mix', narrationWindows)
log(`\nlevels  new: ${JSON.stringify(newStats)}`)
log(`levels  old: ${JSON.stringify(oldStats)}`)

function writeExcerpt(name, source, sampleRate, startSec, seconds) {
  const from = Math.floor(startSec * sampleRate)
  const to = Math.min(source[0].length, from + Math.floor(seconds * sampleRate))
  const channels = source.map((channel) => channel.subarray(from, to))
  return writeFile(join(excerptDir, name), encodeWav({ sampleRate, channels, bitDepth: 16 }))
}

for (const [name, start] of [['opening', 0], ['climax', 57.5], ['ending', 74]]) {
  await writeExcerpt(`new-${name}.wav`, mixedWav.channels, mixedWav.sampleRate, start, 10)
  await writeExcerpt(`old-${name}.wav`, originalWav.channels, originalWav.sampleRate, start, 10)
  await writeExcerpt(`numpy-music-${name}.wav`, numpyMusicWav.channels, numpyMusicWav.sampleRate, start, 10)
}
log(`excerpts written to ${excerptDir}`)

// --- verify the MP4 ---
if (ffmpeg && mix.mux?.ok) {
  const videoPath = join(outDir, '愚公移山-anyaudio.mp4')
  let probe = ''
  try {
    await runFfmpeg(ffmpeg.command, ['-hide_banner', '-i', videoPath, '-f', 'null', '-'])
  } catch (error) {
    probe = error.message
  }
  const info = await readFile(videoPath).then((buffer) => buffer.length).catch(() => 0)
  log(`mp4: ${videoPath} (${(info / 1024 / 1024).toFixed(1)} MB)${probe ? `, ffmpeg probe: ${probe}` : ', ffmpeg probe ok'}`)
}

await writeFile(join(outDir, 'report.md'), `${report.join('\n')}\n`)
log(`\nreport: ${join(outDir, 'report.md')}`)

const checks = [
  ['duration matches the film', Math.abs(newStats.durationSec - total) < 0.05],
  ['no clipped samples', newStats.clipped === 0 && newStats.peakDb <= -1],
  ['audible but not hot', newStats.rmsDb > -30 && newStats.rmsDb < -10],
  ['narration ducking measured', Number(mix.ducking.measuredDropDb) <= -3],
  ['mp4 produced', Boolean(mix.mux?.ok) && ffmpeg !== null],
]
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}
process.exit(failed === 0 ? 0 : 1)
