/**
 * Every tool's `output.render`, against the value its own `execute` returns.
 *
 * The gap this closes: `anyaudio_project`'s read mode returned `clips` per track
 * while its renderer read `track.items`, so `mode:"read"` crashed inside the host
 * with `output.render failed: Cannot read properties of undefined (reading
 * 'length')`. Nothing caught it because no test ever ran `output.render` — they
 * all asserted `execute` directly, and `verify.mjs` only checks that the function
 * exists. The same blind spot covered every tool.
 *
 * Each case runs the real execute against a scratch workspace, feeds that exact
 * value to the real renderer, and requires non-empty text back.
 */
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repoRoot, '.anyaudio', 'test-tmp-renderers')
const workspaceRoot = join(scratch, 'workspace')

process.env.ANYAUDIO_STATE = join(scratch, 'state.json')
process.env.ANYAUDIO_CONFIG = join(scratch, 'config.json')

await rm(scratch, { recursive: true, force: true })
await mkdir(workspaceRoot, { recursive: true })

const { encodeWav } = await import('../src/audio/wav.js')
const { registerAllTools } = await import('../src/tools/index.js')

const tools = new Map()
const ctx = {
  inject: (_deps, run) => run(ctx),
  effect: (run) => run(),
  get: () => undefined,
  logger: () => {},
  tools: { register: (definition) => tools.set(definition.name, definition) },
}
await registerAllTools(ctx, () => {})

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

function makeExec() {
  return { agent: { workspaceRoot }, signal: new AbortController().signal }
}

/**
 * Run a tool and feed its own result to its own renderer. This is the exact
 * path the host walks, so a field name that only exists on one side fails here.
 */
async function renderOf(name, args) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  assert.equal(typeof definition.output?.render, 'function', `${name} has no output.render`)
  const value = await definition.execute(args, makeExec())
  const blocks = definition.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} returned no blocks`)
  const text = blocks.map((block) => block?.text ?? '').join('\n')
  assert.ok(text.trim().length > 0, `${name} rendered empty text`)
  // `undefined`/`NaN` in the text means a field was read that the value does not
  // have — the same class of bug as a hard crash, but silent.
  assert.ok(!/undefined|NaN|null/.test(text), `${name} rendered a missing field: ${text}`)
  return text
}

async function writeTone(name, seconds, hz = 440) {
  const sampleRate = 48000
  const frames = Math.round(seconds * sampleRate)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const value = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.5
    left[i] = value
    right[i] = value
  }
  const path = join(scratch, name)
  await writeFile(path, encodeWav({ sampleRate, channels: [left, right], bitDepth: 16 }))
  return path
}

// --- anyaudio_project: every mode -------------------------------------------

let projectId

await test('project create renders', async () => {
  const text = await renderOf('anyaudio_project', { mode: 'create', name: '渲染器检查' })
  assert.match(text, /Created project/)
  assert.match(text, /Add material with mode "add_material"/)
})

await test('project add_material renders, and the track list is real', async () => {
  const existing = await tools.get('anyaudio_project').execute({ mode: 'read' }, makeExec())
  projectId = existing.projects[0].id
  const tone = await writeTone('tone-render.wav', 2)
  const text = await renderOf('anyaudio_project', {
    mode: 'add_material',
    projectId,
    sourcePath: tone,
    kind: 'music-stem',
    trackName: '鼓',
    category: 'music',
    label: '鼓 A',
  })
  assert.match(text, /Added music-stem material/)
  assert.match(text, /Placed it on "鼓"/)
  assert.match(text, /Project now has 1 tracks/)
})

await test('project read without an id renders the project list', async () => {
  const text = await renderOf('anyaudio_project', { mode: 'read' })
  assert.match(text, /^Projects:/)
  assert.match(text, /渲染器检查/)
})

await test('project read with an id renders tracks and clips', async () => {
  // This is the case that crashed: the value has `clips`, the renderer read
  // `items`, and `.length` on undefined threw inside the host.
  const text = await renderOf('anyaudio_project', { mode: 'read', projectId })
  assert.match(text, /Project "渲染器检查"/)
  assert.match(text, /Tracks \(1 of/)
  assert.match(text, /- 鼓 \[music\]/)
  assert.match(text, /\(1 clips\)/)
  assert.match(text, /鼓 A/)
})

await test('project read with an id renders an empty track honestly', async () => {
  const empty = await tools.get('anyaudio_project').execute({ mode: 'create', name: '空工程' }, makeExec())
  await tools.get('anyaudio_project').execute({ mode: 'update', projectId: empty.projectId, changes: [{ target: 'track' }] }, makeExec()).catch(() => {})
  const definition = tools.get('anyaudio_project')
  // Build the "a track with no clips" value by hand: add_material always places
  // a clip, so an empty track only arises from a delete or an update.
  const value = {
    ok: true,
    mode: 'read',
    projectId: 'prj_x',
    name: '空工程',
    durationSec: 0,
    folder: '.',
    tracks: [{ id: 'trk_a', name: '空轨', category: 'music', volumeDb: 0, pan: 0, muted: false, solo: false, clips: [] }],
    materials: [],
    video: null,
  }
  const text = definition.output.render({ mode: 'read' }, value).map((block) => block.text).join('\n')
  assert.match(text, /\(empty\)/, `empty track should say so, got: ${text}`)
})

await test('project update renders each applied note', async () => {
  const track = (await tools.get('anyaudio_project').execute({ mode: 'read', projectId }, makeExec())).tracks[0]
  const text = await renderOf('anyaudio_project', {
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: track.id, field: 'volumeDb', value: -6 }],
  })
  assert.match(text, /Applied 1 change/)
  assert.match(text, /- /)
})

await test('project render reports counts, not an array', async () => {
  // The value carries trackCount/clipCount; reading them as `tracks`/`clips`
  // printed "undefined tracks" without throwing.
  const text = await renderOf('anyaudio_project', { mode: 'render', projectId, format: 'wav' })
  assert.match(text, /Rendered [\d.]+s of 1 tracks \(1 clips\)/)
  assert.match(text, /peak .* dBFS, RMS .* dBFS/)
})

// --- the other tools ---------------------------------------------------------

await test('sources catalog renders', async () => {
  const text = await renderOf('anyaudio_sources', { action: 'kinds' })
  assert.ok(text.trim().length > 0)
})

await test('sources instruments renders', async () => {
  const text = await renderOf('anyaudio_sources', { action: 'instruments' })
  assert.ok(text.trim().length > 0)
})

await test('music renders', async () => {
  const text = await renderOf('anyaudio_music', {
    projectId,
    score: {
      title: '渲染检查曲',
      tracks: [{ name: 'lead', instrument: 'piano', notes: [[0, 1, 'C4', 90], [1, 1, 'E4', 90]] }],
    },
    durationSec: 2,
    tailSec: 0.2,
  })
  assert.ok(text.trim().length > 0)
})

await test('sfx materials mode renders', async () => {
  const text = await renderOf('anyaudio_sfx', {
    projectId,
    mode: 'materials',
    items: [{ type: 'impact', durationSec: 0.4 }, { type: 'rain', durationSec: 0.4 }],
  })
  assert.ok(text.trim().length > 0)
})

await test('sfx timeline mode renders', async () => {
  const text = await renderOf('anyaudio_sfx', {
    projectId,
    items: [{ type: 'impact', startSec: 0, durationSec: 0.3 }],
    durationSec: 0.5,
  })
  assert.ok(text.trim().length > 0)
})

await test('mix renders', async () => {
  const tone = await writeTone('tone-mix.wav', 1)
  const text = await renderOf('anyaudio_mix', {
    tracks: [{ role: 'music', path: tone }],
    durationSec: 1,
    output: join(scratch, 'mix-out.wav'),
  })
  assert.ok(text.trim().length > 0)
})

console.log(`\n${passed} passed, ${failed} failed`)
await rm(scratch, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
