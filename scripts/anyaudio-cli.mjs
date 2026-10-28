#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { resolveFont } from '../src/audio/fonts.js'
import { compileScore } from '../src/audio/score.js'
import { loadSoundBank, renderCompiled } from '../src/audio/synth.js'
import { encodeWav } from '../src/audio/wav.js'

const USAGE = `AnyAudio headless renderer (no DSH required)

  node scripts/anyaudio-cli.mjs render <score.json> <out.wav> [options]

Options:
  --font <path>       SoundFont file to use instead of the discovered default
  --duration <sec>    exact output length (default: end of the last note)
  --peak <dB>         peak normalisation target (default -3, use "none" to keep the raw level)
  --rate <hz>         sample rate (default 48000)
`

const [command, ...rest] = process.argv.slice(2)
if (!command || command === '-h' || command === '--help') {
  console.log(USAGE.trim())
  process.exit(command ? 0 : 1)
}
if (command !== 'render') {
  console.error(`unknown command "${command}"\n\n${USAGE.trim()}`)
  process.exit(1)
}

const positional = []
const flags = {}
for (let index = 0; index < rest.length; index++) {
  const item = rest[index]
  if (!item.startsWith('--')) {
    positional.push(item)
    continue
  }
  const [key, inline] = item.slice(2).split('=', 2)
  flags[key] = inline ?? rest[++index]
}

const [scorePath, outPath] = positional
if (!scorePath || !outPath) {
  console.error(`render needs a score file and an output file\n\n${USAGE.trim()}`)
  process.exit(1)
}

const sampleRate = Math.round(Number(flags.rate) || 48000)
const peakArg = flags.peak ?? '-3'
const peakDb = peakArg === 'none' || peakArg === 'null' ? null : Number(peakArg)
const durationSec = flags.duration === undefined ? undefined : Number(flags.duration)

const score = JSON.parse(await readFile(resolve(scorePath), 'utf8'))
const compiled = compileScore(score, { sampleRate })
const fontPath = await resolveFont({ path: flags.font, workspaceRoot: process.cwd() })
const bank = await loadSoundBank(fontPath)
const rendered = await renderCompiled(compiled, { soundBank: bank, sampleRate, durationSec, peakDb, normalize: peakDb !== null })

const target = resolve(outPath)
await mkdir(dirname(target), { recursive: true })
await writeFile(target, encodeWav({ sampleRate: rendered.sampleRate, channels: rendered.channels }))

console.log(
  JSON.stringify(
    {
      ok: true,
      out: target,
      durationSec: Number(rendered.durationSec.toFixed(3)),
      peakDb: Number(rendered.peakDb.toFixed(2)),
      rmsDb: Number(rendered.rmsDb.toFixed(2)),
      font: fontPath,
      tracks: compiled.tracks.map((track) => ({ name: track.name, instrument: track.instrument, notes: track.notes.length })),
    },
    null,
    2,
  ),
)
