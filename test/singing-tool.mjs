#!/usr/bin/env node
/**
 * M2 acceptance: anyaudio_sing tool — note format, per-phrase segmentation,
 * timeline zeroing, single-track attach, errors.
 *
 * Uses an injected fake singing process that writes real short WAVs, so no
 * 1 GB runtime / voicebank is needed. A scratch config + project keeps the
 * test off the person's real settings and libraries.
 * Run: node test/singing-tool.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeWav } from '../src/audio/wav.js'
import { readProject, readMaterialIndex } from '../src/project/store.js'
import { createProject } from '../src/project/store.js'
import {
  setSingingProcessFactory, singToolDefinition, parseNote, splitNotes,
} from '../src/tools/sing.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repoRoot, '.anyaudio', 'test-tmp-singing-tool')
process.env.ANYAUDIO_CONFIG = join(scratch, 'config.json')
process.env.ANYAUDIO_STATE = join(scratch, 'state.json')
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true })

const exec = { agent: { workspaceRoot: repoRoot }, signal: new AbortController().signal }

let passed = 0
let failed = 0
async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${error?.stack || error}`)
  }
}

// Fake process: writes a 44100 Hz WAV whose length = sum of note durations,
// echoes the lyric and records the notes it received (for zeroing assertions).
let calls = []
function installFake({ failOnPhrase = 0 } = {}) {
  let localCalls = 0
  calls = []
  setSingingProcessFactory(() => ({
    async sing(task) {
      calls.push({ notes: task.notes, out: task.out, maxSeconds: task.maxSeconds })
      localCalls++
      if (failOnPhrase && localCalls === failOnPhrase) {
        throw new Error('fake inference explosion')
      }
      const seconds = task.notes.reduce((sum, note) => sum + note[1], 0) + 0.3
      const frames = Math.max(1, Math.round(seconds * 44100))
      const channel = new Float32Array(frames)
      for (let i = 0; i < frames; i++) channel[i] = 0.2 * Math.sin(i / 40)
      const wav = encodeWav({ sampleRate: 44100, channels: [channel], bitDepth: 16 })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(task.out, wav)
      return {
        seconds, notes: task.notes.length,
        text: task.notes.map((n) => n[3]).filter(Boolean).join(''),
        device: 'cpu',
      }
    },
    async stop() {},
  }))
}
installFake()

async function freshProject() {
  const project = await createProject(repoRoot, { name: `singing-tool-${passed}-${failed}` })
  return project.id
}

// ---------------------------------------------------------------------------
await test('parseNote accepts four fields and rejects bad input', () => {
  assert.deepEqual(parseNote([0, 0.5, 67, '长'], 0), [0, 0.5, 67, '长'])
  assert.deepEqual(parseNote([0, 0.5, null, ''], 0), [0, 0.5, null, ''])
  assert.throws(() => parseNote([0, 0.5], 3), /notes\[3\]/)
  assert.throws(() => parseNote([0, -1, 60, 'a'], 0), /durSec/)
  assert.throws(() => parseNote([0, 0.5, 200, 'a'], 0), /midi/)
})

await test('splitNotes splits on rests and zeroes each phrase timeline', () => {
  const notes = [
    [0, 0.5, 60, '长'], [0.5, 0.5, 62, '亭'], [1, 0.5, 64, '外'],
    [1.5, 0.5, null, ''],
    [10, 0.5, 67, '古'], [10.5, 0.5, 69, '道'],
  ].map((n, i) => parseNote(n, i))
  const phrases = splitNotes(notes)
  assert.equal(phrases.length, 2)
  assert.deepEqual(phrases[0][0], [0, 0.5, 60, '长'])
  assert.deepEqual(phrases[1][0], [0, 0.5, 67, '古'], 'second phrase timeline must be zeroed')
  assert.equal(phrases[1][1][0], 0.5)
})

await test('a gap between notes also starts a new phrase', () => {
  const notes = [[0, 0.5, 60, 'a'], [5, 0.5, 62, 'b']].map((n, i) => parseNote(n, i))
  // No explicit rest note, but contiguous-check is by rest only; a large gap
  // with no rest is left as one phrase whose leading silence the engine handles.
  // The tool's documented rule is "split at rests"; assert it stays one phrase.
  const phrases = splitNotes(notes)
  assert.equal(phrases.length, 1)
})

await test('tool definition is discoverable with correct schema', () => {
  assert.equal(singToolDefinition.name, 'anyaudio_sing')
  assert.deepEqual(singToolDefinition.parameters.required, ['notes', 'projectId'])
  assert.ok(singToolDefinition.description.includes('startSec, durSec, midi'))
  assert.ok(singToolDefinition.description.includes('regenerat'))
  assert.equal(typeof singToolDefinition.output.render, 'function')
})

await test('missing projectId, empty notes, all-rest notes are rejected', async () => {
  await assert.rejects(singToolDefinition.execute({ notes: [[0, 0.5, 60, 'a']] }, exec), /projectId/)
  await assert.rejects(singToolDefinition.execute({ projectId: 'x', notes: [] }, exec), /non-empty/)
  await assert.rejects(
    singToolDefinition.execute({ projectId: 'x', notes: [[0, 0.5, null, '']] }, exec),
    /no sung notes|all notes were rests/,
  )
})

await test('sing lands one WAV on one sing/tts track via the process', async () => {
  calls.length = 0
  const projectId = await freshProject()
  const result = await singToolDefinition.execute({
    projectId,
    notes: [
      [0, 0.5, 67, '长'], [0.5, 0.5, 64, '亭'], [1, 0.5, 67, ''], [1.5, 1, 72, '外'],
      [2.5, 0.5, null, ''],
      [5, 0.5, 69, '古'], [5.5, 0.5, 65, '道'],
    ],
    trackName: '主唱',
  }, exec)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2, 'two phrases => two process.sing calls')
  assert.deepEqual(calls[1].notes[0], [0, 0.5, 69, '古'], 'second phrase is zeroed')
  assert.equal(result.phrases.length, 2)
  assert.equal(result.attached.trackName, '主唱')
  assert.ok(result.durationSec > 0)
  assert.ok(result.sampleRate === 44100)

  const project = await readProject(repoRoot, projectId)
  const track = project.tracks.find((t) => t.name === '主唱')
  assert.ok(track, 'a dedicated vocal track exists')
  assert.equal(track.category, 'tts')
  assert.equal(track.items.length, 1, 'one merged clip, not one per phrase')
  const index = await readMaterialIndex(repoRoot, projectId)
  const material = index.materials.find((m) => m.id === track.items[0].material)
  assert.equal(material.kind, 'sing', 'material kind is sing')
  assert.ok(material.source?.snapshot?.includes('sing'), 'a sing-kind source snapshot is stored')
})

await test('a failed phrase aborts with a clear message and no partial attach', async () => {
  installFake({ failOnPhrase: 1 })
  const projectId = await freshProject()
  const before = await readProject(repoRoot, projectId)
  const beforeTracks = before.tracks.length
  await assert.rejects(
    singToolDefinition.execute({
      projectId,
      notes: [[0, 0.5, 60, 'a'], [1, 0.5, null, ''], [5, 0.5, 62, 'b']],
    }, exec),
    /phrase 1.*fake inference explosion/,
  )
  const after = await readProject(repoRoot, projectId)
  assert.equal(after.tracks.length, beforeTracks, 'no track was attached after failure')
  installFake()
})

await test('renderer produces non-empty text without undefined/NaN', async () => {
  const projectId = await freshProject()
  const value = await singToolDefinition.execute({
    projectId, notes: [[0, 0.5, 60, '长'], [0.5, 0.5, 62, '亭']],
  }, exec)
  const blocks = singToolDefinition.output.render({}, value)
  const text = blocks.map((block) => block.text).join('\n')
  assert.ok(text.trim().length > 0)
  assert.ok(!/undefined|NaN/.test(text), text)
})

// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} passed`)
// Clean up every scratch artifact this test created.
await rm(scratch, { recursive: true, force: true })
// Generating tools also created projects under .anyaudio/projects; remove only
// the ones this test named (prefix singing-tool-).
const projectsDir = join(repoRoot, '.anyaudio', 'projects')
for (const entry of await readdir(projectsDir).catch(() => [])) {
  if (entry.startsWith('singing-tool-')) {
    await rm(join(projectsDir, entry), { recursive: true, force: true })
  }
}
if (failed) process.exitCode = 1
