/**
 * `anyaudio_project` and the timeline reference expansion (plan M6).
 *
 * The tool is the whole point of M6: without `create` + `add_material` the Agent
 * generates files that a person has to drag in by hand, so these tests build a
 * project exactly the way the Agent would and then check the result on disk.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repoRoot, '.anyaudio', 'test-tmp-project')
const workspaceRoot = join(scratch, 'workspace')

// Redirect every state path before importing anything that reads config.
process.env.ANYAUDIO_STATE = join(scratch, 'state.json')
process.env.ANYAUDIO_CONFIG = join(scratch, 'config.json')

await rm(scratch, { recursive: true, force: true })
await mkdir(workspaceRoot, { recursive: true })

const { encodeWav } = await import('../src/audio/wav.js')
const { projectToolDefinition } = await import('../src/tools/project.js')
const { parseTimelineMentions, describeReference, expandTimelineReferences, formatTime } = await import('../src/host/timeline-ref.js')
const { readProject, readMaterialIndex } = await import('../src/project/store.js')

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
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  )
}

/** The exec object the tool sees; only the workspace root matters here. */
function makeExec() {
  return { agent: { workspaceRoot } }
}

/**
 * Tools signal failure by throwing (the harness turns the message into the error
 * the model sees), so a test that expects a refusal must catch it and look at the
 * text.
 */
async function call(args) {
  try {
    return await projectToolDefinition.execute(args, makeExec())
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** A real 48 kHz stereo WAV of a steady tone, so imports have something to read. */
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

let projectId

await test('create makes a project skeleton and returns its id', async () => {
  const result = await call({ mode: 'create', name: '海边主题曲' })
  assert.equal(result.ok, true)
  assert.match(result.projectId, /^prj_[A-Za-z0-9_-]+$/)
  assert.equal(result.name, '海边主题曲')
  projectId = result.projectId
  const onDisk = JSON.parse(await readFile(join(workspaceRoot, '.anyaudio', 'projects', projectId, 'project.json'), 'utf8'))
  assert.equal(onDisk.schemaVersion, 1)
  assert.equal(onDisk.tracks.length, 0)
  assert.equal(onDisk.history[0].by, 'agent')
})

await test('create makes a second project with its own folder, not an overwrite', async () => {
  // The folder is keyed by id, so two projects may share a name; what must never
  // happen is the second one reusing the first one's id or folder.
  const second = await call({ mode: 'create', name: '海边主题曲' })
  assert.equal(second.ok, true)
  assert.notEqual(second.projectId, projectId)
  const firstOnDisk = JSON.parse(await readFile(join(workspaceRoot, '.anyaudio', 'projects', projectId, 'project.json'), 'utf8'))
  assert.equal(firstOnDisk.id, projectId)
})

await test('read without a project id lists the workspace projects', async () => {
  const result = await call({ mode: 'read' })
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.projects))
  assert.ok(result.projects.some((row) => row.id === projectId))
})

await test('add_material imports a file and places it on a new track', async () => {
  const tone = await writeTone('tone-a.wav', 3)
  const result = await call({
    mode: 'add_material',
    projectId,
    sourcePath: tone,
    kind: 'music-stem',
    trackName: '鼓',
    category: 'music',
    startSec: 1,
    gainDb: -2,
    label: '鼓 A',
  })
  assert.equal(result.ok, true)
  assert.equal(result.material.kind, 'music-stem')
  assert.equal(result.material.durationSec, 3)
  assert.equal(result.clip.trackName, '鼓')
  assert.equal(result.clip.startSec, 1)
  assert.equal(result.tracks.length, 1)
  assert.equal(result.tracks[0].name, '鼓')
  assert.equal(result.tracks[0].category, 'music')
  assert.equal(result.tracks[0].clips.length, 1)
  assert.equal(result.tracks[0].clips[0].label, '鼓 A')
  assert.equal(result.tracks[0].clips[0].gainDb, -2)

  const index = await readMaterialIndex(workspaceRoot, projectId)
  assert.equal(index.materials.length, 1)
  assert.match(index.materials[0].file, /^materials\/.+\.wav$/)
  const materialStat = await stat(join(workspaceRoot, '.anyaudio', 'projects', projectId, index.materials[0].file))
  assert.ok(materialStat.size > 0, 'the material file must exist')
})

await test('add_material reuses an existing track with the same name', async () => {
  const tone = await writeTone('tone-b.wav', 2, 330)
  const result = await call({
    mode: 'add_material',
    projectId,
    sourcePath: tone,
    kind: 'music-stem',
    trackName: '鼓',
    startSec: 5,
  })
  assert.equal(result.ok, true)
  assert.equal(result.tracks.length, 1, 'a second material on the same track must not create a track')
  assert.equal(result.tracks[0].clips.length, 2)
})

await test('add_material without a track name only registers the material', async () => {
  const tone = await writeTone('tone-c.wav', 1, 550)
  const result = await call({
    mode: 'add_material',
    projectId,
    sourcePath: tone,
    kind: 'foley',
  })
  assert.equal(result.ok, true)
  assert.equal(result.clip, null)
  assert.equal(result.materials.length, 3)
  assert.equal(result.tracks.length, 1, 'no track may be created without a name')
})

await test('add_material puts a picture soundtrack on its own track without being told', async () => {
  // Improvement plan 01, I-02. Before this, importing a video registered the
  // extracted soundtrack as a material and left it off the timeline, so the
  // picture's own sound was silent until someone dragged it in by hand.
  const { findFfmpeg } = await import('../src/tools/shared.js')
  if (!findFfmpeg()) {
    console.log('     (skipped: ffmpeg is not available)')
    return
  }
  const { runFfmpeg } = await import('../src/tools/shared.js')
  const pictureProject = await call({ mode: 'create', name: '带画面的工程' })
  const mp4 = join(scratch, 'tool-picture.mp4')
  await runFfmpeg(findFfmpeg().command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=64x64:d=2:r=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4,
  ])

  const result = await call({ mode: 'add_material', projectId: pictureProject.projectId, sourcePath: mp4 })
  assert.equal(result.ok, true)
  assert.ok(result.clip, 'the soundtrack must land on a track without a trackName')
  assert.equal(result.clip.startSec, 0, 'the soundtrack starts with the picture')
  const track = result.tracks.find((entry) => entry.id === result.clip.trackId) ?? result.tracks[0]
  assert.equal(track.category, 'video-audio', 'the track is categorised as the picture soundtrack')
  assert.equal(track.clips.length, 1)
  assert.match(track.name, /画面原声/, 'the track is named after the picture')
})

await test('add_material still honours an explicit track name for a picture', async () => {
  // An Agent that wants the soundtrack elsewhere keeps control.
  const { findFfmpeg, runFfmpeg } = await import('../src/tools/shared.js')
  if (!findFfmpeg()) return
  const secondProject = await call({ mode: 'create', name: '原声另放' })
  const mp4 = join(scratch, 'tool-picture-2.mp4')
  await runFfmpeg(findFfmpeg().command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=teal:s=64x64:d=2:r=5',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', mp4,
  ])
  const result = await call({
    mode: 'add_material',
    projectId: secondProject.projectId,
    sourcePath: mp4,
    trackName: '我自己的轨',
    category: 'other',
  })
  assert.equal(result.ok, true)
  assert.equal(result.clip.trackName, '我自己的轨')
  assert.equal(result.tracks.length, 1)
  assert.equal(result.tracks[0].category, 'other')
})

await test('add_material reports a silent picture instead of failing', async () => {
  // A picture with no audio stream is usable as a reference picture; it simply
  // has nothing to place.
  const { findFfmpeg, runFfmpeg } = await import('../src/tools/shared.js')
  if (!findFfmpeg()) return
  const silentProject = await call({ mode: 'create', name: '无声画面' })
  const mp4 = join(scratch, 'tool-silent.mp4')
  await runFfmpeg(findFfmpeg().command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2:r=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', mp4,
  ])
  const result = await call({ mode: 'add_material', projectId: silentProject.projectId, sourcePath: mp4 })
  assert.equal(result.ok, true, 'a silent picture is not an import failure')
  assert.equal(result.silent, true)
  assert.equal(result.material, null)
  assert.equal(result.clip, null)
  assert.equal(result.tracks.length, 0, 'no empty track is created for a missing soundtrack')
  assert.ok(result.durationSec >= 2, 'the picture still sets the project length')
})

await test('add_material trims outSec to the material length', async () => {
  const tone = await writeTone('tone-d.wav', 1, 660)
  const result = await call({
    mode: 'add_material',
    projectId,
    sourcePath: tone,
    kind: 'foley',
    trackName: '动效',
    category: 'foley',
    startSec: 10,
    outSec: 99,
  })
  assert.equal(result.ok, true)
  const clip = result.tracks.find((track) => track.name === '动效').clips[0]
  assert.equal(clip.outSec, 1)
})

await test('add_material refuses an empty clip range', async () => {
  const tone = await writeTone('tone-e.wav', 1, 770)
  const result = await call({
    mode: 'add_material',
    projectId,
    sourcePath: tone,
    kind: 'foley',
    trackName: '动效',
    inSec: 0.9,
    outSec: 0.5,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /range .* is empty/)
})

await test('add_material rejects a file that does not exist', async () => {
  const result = await call({
    mode: 'add_material',
    projectId,
    sourcePath: join(scratch, 'nope.wav'),
    kind: 'foley',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /could not import/)
})

await test('update changes a track field and records the change', async () => {
  const before = await readProject(workspaceRoot, projectId)
  const track = before.tracks[0]
  const result = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: track.id, field: 'volumeDb', value: -5 }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.tracks[0].volumeDb, -5)
  assert.ok(result.applied.length === 1)
  const after = await readProject(workspaceRoot, projectId)
  const last = after.history.at(-1)
  assert.equal(last.by, 'agent')
  assert.match(last.note, /音量/)
})

await test('update changes several clips in one call', async () => {
  const project = await readProject(workspaceRoot, projectId)
  const track = project.tracks[0]
  const [first] = track.items
  const result = await call({
    mode: 'update',
    projectId,
    changes: [
      { target: 'clip', trackId: track.id, clipId: first.id, field: 'gainDb', value: 3 },
      { target: 'clip', trackId: track.id, clipId: first.id, field: 'pan', value: -0.5 },
    ],
  })
  assert.equal(result.ok, true)
  const clip = result.tracks[0].clips[0]
  assert.equal(clip.gainDb, 3)
  assert.equal(clip.pan, -0.5)
  assert.equal(result.applied.length, 2)
})

await test('update refuses an unknown track, clip or field', async () => {
  const missingTrack = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: 'trk_nope', field: 'volumeDb', value: 0 }],
  })
  assert.equal(missingTrack.ok, false)
  assert.match(missingTrack.error, /no such track/)

  const project = await readProject(workspaceRoot, projectId)
  const badClip = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'clip', trackId: project.tracks[0].id, clipId: 'itm_nope', field: 'gainDb', value: 0 }],
  })
  assert.equal(badClip.ok, false)
  assert.match(badClip.error, /no such clip/)

  const badField = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: project.tracks[0].id, field: 'width', value: 1 }],
  })
  assert.equal(badField.ok, false)
  assert.match(badField.error, /unknown track field/)
})

await test('update refuses an edit that would break the duration limit', async () => {
  const project = await readProject(workspaceRoot, projectId)
  const track = project.tracks[0]
  const clip = track.items[0]
  const result = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'clip', trackId: track.id, clipId: clip.id, field: 'startSec', value: 1000 }],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /limit is 900s/)
})

await test('update with no changes is refused', async () => {
  const result = await call({ mode: 'update', projectId, changes: [] })
  assert.equal(result.ok, false)
  assert.match(result.error, /at least one edit/)
})

await test('render writes a wav and reports its shape', async () => {
  const result = await call({ mode: 'render', projectId, format: 'wav' })
  assert.equal(result.ok, true)
  assert.match(result.file, /\.wav$/)
  const written = await stat(result.file)
  assert.ok(written.size > 1000, `the rendered file is suspiciously small: ${written.size}`)
  assert.ok(result.durationSec > 0)
  // `tracks`/`clips` are declared as arrays in the output schema, so the counts
  // live under their own names — a number in an array field makes the host throw
  // the whole result away. By this point the project holds two tracks (鼓, 动效)
  // and three clips; the earlier tests added them and never cleaned up.
  assert.equal(result.trackCount, 2)
  assert.equal(result.clipCount, 3)
})

await test('render honours an explicit output path', async () => {
  const target = join(workspaceRoot, 'custom-out.wav')
  const result = await call({ mode: 'render', projectId, format: 'wav', output: 'custom-out.wav' })
  assert.equal(result.ok, true)
  assert.equal(result.file, target)
})

await test('an unknown mode is refused', async () => {
  const result = await call({ mode: 'delete' })
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown mode/)
})

// --- timeline references -------------------------------------------------

await test('formatTime renders milliseconds', () => {
  assert.equal(formatTime(72), '00:01:12.000')
  assert.equal(formatTime(86.5), '00:01:26.500')
  assert.equal(formatTime(3661.25), '01:01:01.250')
  assert.equal(formatTime(-5), '00:00:00.000')
})

await test('a mention is parsed into a project, a target and a range', () => {
  const text = '把这段改一下 @[鼓组 00:01:12–00:01:26](anyaudio://timeline/prj_ab12cd34/trk_01@72.0-86.0) 谢谢'
  const parsed = parseTimelineMentions(text)
  assert.equal(parsed.references.length, 1)
  const [reference] = parsed.references
  assert.equal(reference.projectId, 'prj_ab12cd34')
  assert.equal(reference.target, 'trk_01')
  assert.equal(reference.fromSec, 72)
  assert.equal(reference.toSec, 86)
  assert.equal(parsed.text, '把这段改一下 @鼓组 00:01:12–00:01:26 谢谢')
})

await test('a mention without a range keeps a null range', () => {
  const parsed = parseTimelineMentions('@[鼓](anyaudio://timeline/prj_1/trk_02)')
  assert.equal(parsed.references[0].fromSec, null)
  assert.equal(parsed.references[0].toSec, null)
  assert.equal(parsed.text, '@鼓')
})

await test('a bare uri without the markdown wrapper is left alone', () => {
  const parsed = parseTimelineMentions('anyaudio://timeline/prj_1/trk_02')
  assert.equal(parsed.references.length, 0)
})

await test('describeReference names the track and the clips inside the range', async () => {
  const project = await readProject(workspaceRoot, projectId)
  const materials = (await readMaterialIndex(workspaceRoot, projectId)).materials
  const track = project.tracks.find((entry) => entry.name === '鼓')
  const description = describeReference(project, materials, {
    label: '鼓组',
    projectId,
    target: track.id,
    fromSec: 1,
    toSec: 6,
  })
  assert.match(description, /工程：海边主题曲/)
  assert.match(description, /轨道：鼓（trk_/)
  assert.match(description, /时间范围：00:00:01\.000 — 00:00:06\.000/)
  assert.match(description, /落在范围内的片段/)
  assert.match(description, /鼓 A/)
})

await test('describeReference reports an empty range', async () => {
  const project = await readProject(workspaceRoot, projectId)
  const materials = (await readMaterialIndex(workspaceRoot, projectId)).materials
  const track = project.tracks[0]
  const description = describeReference(project, materials, {
    label: 'x',
    projectId,
    target: track.id,
    fromSec: 500,
    toSec: 510,
  })
  assert.match(description, /这个范围在轨道上是空的/)
})

await test('describeReference names the clip when the target is a clip', async () => {
  const project = await readProject(workspaceRoot, projectId)
  const materials = (await readMaterialIndex(workspaceRoot, projectId)).materials
  const track = project.tracks[0]
  const item = track.items[0]
  const description = describeReference(project, materials, {
    label: '鼓 A',
    projectId,
    target: item.id,
    fromSec: null,
    toSec: null,
  })
  assert.match(description, /片段：鼓 A/)
  assert.match(description, /位置：00:00:/)
  assert.match(description, /参数：增益/)
})

await test('describeReference survives a target that no longer exists', () => {
  const description = describeReference({ name: 'x', id: 'prj_1', tracks: [] }, [], {
    label: 'gone',
    projectId: 'prj_1',
    target: 'trk_gone',
    fromSec: null,
    toSec: null,
  })
  assert.match(description, /已经没有这个轨道或片段/)
})

await test('expandTimelineReferences splits a message into text plus context', async () => {
  const project = await readProject(workspaceRoot, projectId)
  const track = project.tracks.find((entry) => entry.name === '鼓')
  const messages = [
    {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: `这段不够激昂 @[鼓](anyaudio://timeline/${project.id}/${track.id}@1.0-4.0) 底鼓加重些` }],
    },
  ]
  const expanded = await expandTimelineReferences(workspaceRoot, messages)
  assert.equal(expanded.length, 2)
  assert.equal(expanded[0].content[0].text, '这段不够激昂 @鼓 底鼓加重些')
  const context = expanded[1].content[0].text
  assert.match(context, /<anyaudio-timeline>/)
  assert.match(context, /轨道：鼓/)
  assert.match(context, /只动他指到的范围/)
  assert.equal(expanded[1].source.kind, 'any-audio')
})

await test('expandTimelineReferences leaves a message without mentions alone', async () => {
  const messages = [{ id: 'm2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }]
  const expanded = await expandTimelineReferences(workspaceRoot, messages)
  assert.equal(expanded.length, 1)
  assert.equal(expanded[0].content[0].text, '你好')
})

await test('expandTimelineReferences reports a missing project instead of dropping it', async () => {
  const messages = [
    {
      id: 'm3',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '@[鼓](anyaudio://timeline/prj_gone/trk_1@0-5)' }],
    },
  ]
  const expanded = await expandTimelineReferences(workspaceRoot, messages)
  assert.equal(expanded.length, 2)
  assert.match(expanded[1].content[0].text, /读不出来/)
})

await test('expandTimelineReferences ignores messages that are not from the user', async () => {
  const messages = [
    {
      id: 'm4',
      role: 'assistant',
      source: { kind: 'assistant' },
      content: [{ type: 'text', text: '@[鼓](anyaudio://timeline/prj_1/trk_1)' }],
    },
  ]
  const expanded = await expandTimelineReferences(workspaceRoot, messages)
  assert.equal(expanded.length, 1)
})

await test('rendering does not mutate the project on disk', async () => {
  const before = await readFile(join(workspaceRoot, '.anyaudio', 'projects', projectId, 'project.json'), 'utf8')
  await call({ mode: 'render', projectId, format: 'wav' })
  const after = await readFile(join(workspaceRoot, '.anyaudio', 'projects', projectId, 'project.json'), 'utf8')
  assert.equal(after, before)
})

await rm(scratch, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
