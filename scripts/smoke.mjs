#!/usr/bin/env node
/**
 * Loads the plugin the way the harness does (apply(ctx) with the tools,
 * skills and systemPrompt services) against a stub service container, then
 * exercises every registered tool once.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { apply, inject, name } from '../src/index.js'
import { parseWav } from '../src/audio/wav.js'
import { findFfmpeg } from '../src/tools/shared.js'

const repoRoot = resolve('.')
const exec = { agent: { workspaceRoot: repoRoot } }
const tools = new Map()
const skills = []
const sections = []
const logs = []
const services = {
  skills: { register: (skill) => (skills.push(skill), () => {}) },
  systemPrompt: { section: (section) => (sections.push(section), () => {}) },
}
const ctx = {
  get: (id) => services[id],
  tools: { register: (definition) => tools.set(definition.name, definition) },
  logger: { info: (message) => logs.push(message) },
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const step = async (label, run) => {
  try {
    return await run()
  } catch (error) {
    failures++
    console.log(`FAIL ${label} — ${error.message}`)
    return undefined
  }
}

console.log(`plugin: ${name}, inject: ${JSON.stringify(inject)}`)
apply(ctx, {})
await new Promise((resolveWait) => setTimeout(resolveWait, 120))

check('five tools registered', tools.size === 5, [...tools.keys()].join(', '))
check('tool output.render present', [...tools.values()].every((tool) => typeof tool.output?.render === 'function'))
check('tool parameters are JSON Schema objects', [...tools.values()].every((tool) => tool.parameters?.type === 'object'))
check('anyaudio-scoring skill registered', skills.length === 1 && skills[0].name === 'anyaudio-scoring', `${skills[0]?.content?.length ?? 0} chars`)
check('skill content is a real guide', (skills[0]?.content?.length ?? 0) > 3000)
check('system prompt hint registered', sections.length === 1 && sections[0].name === 'any-audio', `order ${sections[0]?.order}`)
check('prompt mentions every tool', ['anyaudio_sources', 'anyaudio_music', 'anyaudio_tts', 'anyaudio_sfx', 'anyaudio_mix'].every((tool) => sections[0]?.text?.includes(tool)))
check(
  'registration logged without errors',
  logs.every((line) => !/failed/i.test(line) && (!/unavailable/i.test(line) || /webServer is unavailable/.test(line))),
  logs.join(' | '),
)

const fonts = await step('anyaudio_sources', () => tools.get('anyaudio_sources').execute({ action: 'list' }, exec))
if (fonts) check('font discovered', fonts.fonts.length > 0, fonts.fonts[0]?.path)

const rendered = await step('anyaudio_music', () =>
  tools.get('anyaudio_music').execute(
    {
      score: {
        title: 'smoke',
        tracks: [
          { name: 'lead', instrument: 'koto', gainDb: -2, reverb: 0.3, notes: [[0, 1.2, 'D4', 84], [1.2, 0.6, 'F4', 76], [1.8, 1.4, 'A4', 92]] },
          { name: 'bass', instrument: 'cello', gainDb: -6, source: 'generaluser', notes: [[0, 3, 'D2', 70]] },
          { name: 'auto-lead', instrument: 'flute', gainDb: -8, source: 'auto', notes: [[0, 1, 'A4', 70]] },
        ],
      },
      output: '.anyaudio/out/smoke-score.wav',
      durationSec: 3,
    },
    exec,
  ),
)
if (rendered) {
  const wav = parseWav(await readFile(rendered.absolutePath))
  check('render length is exact', Math.abs(wav.durationSec - 3) < 0.01, `${wav.durationSec.toFixed(3)}s`)
  check('render peak equals requested', Math.abs(rendered.peakDb - -3) < 0.6, `${rendered.peakDb} dBFS`)
  check('multi-source plan reports fonts', Array.isArray(rendered.fonts) && rendered.fonts.length >= 1, JSON.stringify(rendered.fonts))
}

const sfx = await step('anyaudio_sfx', () =>
  tools.get('anyaudio_sfx').execute(
    {
      items: [
        { type: 'wind', startSec: 0, durationSec: 3, gainDb: -8, params: { intensity: 0.5 } },
        { type: 'impact', startSec: 1.5, durationSec: 1, gainDb: -3 },
      ],
      durationSec: 3,
      output: '.anyaudio/out/smoke-sfx.wav',
    },
    exec,
  ),
)
if (sfx) check('sfx length is exact', sfx.durationSec === 3, `${sfx.peakDb} dBFS`)

const mixed = await step('anyaudio_mix', () =>
  tools.get('anyaudio_mix').execute(
    {
      tracks: [
        { role: 'music', path: rendered?.absolutePath ?? '.anyaudio/out/smoke-score.wav', gainDb: -3, fadeInSec: 0.3, fadeOutSec: 0.6 },
        { role: 'sfx', path: sfx?.absolutePath ?? '.anyaudio/out/smoke-sfx.wav', gainDb: -8 },
      ],
      durationSec: 3,
      output: '.anyaudio/out/smoke-mix.wav',
    },
    exec,
  ),
)
if (mixed) check('mix length is exact', mixed.durationSec === 3, `${mixed.peakDb} dBFS`)

const ffmpeg = findFfmpeg()
console.log(`ffmpeg: ${ffmpeg ? ffmpeg.version : 'not found (video mux reports a clear error and keeps the WAV)'}`)
console.log(failures === 0 ? '\nSmoke test passed.' : `\nSmoke test finished with ${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
