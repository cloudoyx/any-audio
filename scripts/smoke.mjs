#!/usr/bin/env node
/**
 * Loads the plugin the way the harness does (apply(ctx) with the tools,
 * skills and systemPrompt services) against a stub service container, then
 * exercises every registered tool once.
 */
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { apply, inject, name } from '../src/index.js'
import { parseWav } from '../src/audio/wav.js'
import { projectDir } from '../src/project/paths.js'
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

const EXPECTED_TOOLS = ['anyaudio_sources', 'anyaudio_music', 'anyaudio_tts', 'anyaudio_sfx', 'anyaudio_project']

console.log(`plugin: ${name}, inject: ${JSON.stringify(inject)}`)
apply(ctx, {})
await new Promise((resolveWait) => setTimeout(resolveWait, 120))

check('every tool registered', EXPECTED_TOOLS.every((tool) => tools.has(tool)) && tools.size === EXPECTED_TOOLS.length, [...tools.keys()].join(', '))
check('tool output.render present', [...tools.values()].every((tool) => typeof tool.output?.render === 'function'))
check('tool parameters are JSON Schema objects', [...tools.values()].every((tool) => tool.parameters?.type === 'object'))
check('both skills registered', skills.length === 2 && skills.every((skill) => typeof skill.name === 'string' && skill.content.length > 3000), skills.map((skill) => `${skill.name} (${skill.content.length} chars)`).join(', '))
check('system prompt hint registered', sections.length === 1 && sections[0].name === 'any-audio', `order ${sections[0]?.order}`)
check('prompt mentions every tool', EXPECTED_TOOLS.every((tool) => sections[0]?.text?.includes(tool)))
check(
  'registration logged without errors',
  logs.every((line) => !/failed/i.test(line) && (!/unavailable/i.test(line) || /webServer is unavailable/.test(line))),
  logs.join(' | '),
)

const fonts = await step('anyaudio_sources', () => tools.get('anyaudio_sources').execute({ action: 'list' }, exec))
if (fonts) check('font discovered', fonts.fonts.length > 0, fonts.fonts[0]?.path)

// Everything that makes sound now lands in a project, so the smoke run has to
// open one first — that ordering is the product contract, not a test detail.
const project = await step('anyaudio_project create', () => tools.get('anyaudio_project').execute({ mode: 'create', name: 'smoke' }, exec))
if (project) check('project created', typeof project.projectId === 'string' && project.projectId.length > 0, project.projectId)
const projectId = project?.projectId

const rendered = projectId
  ? await step('anyaudio_music', () =>
    tools.get('anyaudio_music').execute(
      {
        projectId,
        score: {
          title: 'smoke',
          tracks: [
            { name: 'lead', instrument: 'koto', gainDb: -2, reverb: 0.3, notes: [[0, 1.2, 'D4', 84], [1.2, 0.6, 'F4', 76], [1.8, 1.4, 'A4', 92]] },
            { name: 'bass', instrument: 'cello', gainDb: -6, source: 'generaluser', notes: [[0, 3, 'D2', 70]] },
            { name: 'auto-lead', instrument: 'flute', gainDb: -8, source: 'auto', notes: [[0, 1, 'A4', 70]] },
          ],
        },
        durationSec: 3,
      },
      exec,
    ),
  )
  : undefined
if (rendered) {
  const wav = parseWav(await readFile(rendered.absolutePath))
  check('render length is exact', Math.abs(wav.durationSec - 3) < 0.01, `${wav.durationSec.toFixed(3)}s`)
  check('render peak equals requested', Math.abs(rendered.peakDb - -3) < 0.6, `${rendered.peakDb} dBFS`)
  check('multi-source plan reports fonts', Array.isArray(rendered.fonts) && rendered.fonts.length >= 1, JSON.stringify(rendered.fonts))
  check('music landed in the project', rendered.absolutePath.startsWith(projectDir(repoRoot, projectId)), rendered.file)
  check('music reports per-track levels', (rendered.tracks ?? []).every((track) => typeof track.rmsDb === 'number'), rendered.tracks.map((track) => `${track.name} ${track.rmsDb ?? '—'}`).join(', '))
}

const sfx = projectId
  ? await step('anyaudio_sfx', () =>
    tools.get('anyaudio_sfx').execute(
      {
        projectId,
        items: [
          { type: 'wind', startSec: 0, durationSec: 3, gainDb: -8, params: { intensity: 0.5 } },
          { type: 'impact', startSec: 1.5, durationSec: 1, gainDb: -3 },
        ],
      },
      exec,
    ),
  )
  : undefined
if (sfx) {
  check('each effect became its own material', (sfx.materials ?? []).length === 2, sfx.materials?.map((material) => material.type).join(', '))
  check('effects landed in the project', (sfx.materials ?? []).every((material) => material.absolutePath.startsWith(projectDir(repoRoot, projectId))))
  check('effects were measured', (sfx.materials ?? []).every((material) => typeof material.peakDb === 'number'), sfx.materials?.map((material) => material.peakDb).join(', '))
}

const exported = projectId
  ? await step('anyaudio_project render', () => tools.get('anyaudio_project').execute({ mode: 'render', projectId, format: 'wav' }, exec))
  : undefined
if (exported) check('project renders to a finished file', exported.durationSec > 0 && typeof exported.file === 'string', `${exported.durationSec}s, ${exported.trackCount} tracks, ${exported.clipCount} clips → ${exported.relative}`)

const ffmpeg = findFfmpeg()
console.log(`ffmpeg: ${ffmpeg ? ffmpeg.version : 'not found (video mux reports a clear error and keeps the WAV)'}`)
// The run creates a real project and a real export; leaving them behind makes
// every smoke run accumulate projects nobody asked for.
if (projectId) await rm(projectDir(repoRoot, projectId), { recursive: true, force: true })
if (exported?.file) await rm(exported.file, { force: true })
console.log(failures === 0 ? '\nSmoke test passed.' : `\nSmoke test finished with ${failures} failure(s).`)
process.exit(failures === 0 ? 0 : 1)
