/**
 * `anyaudio_project` and the timeline reference expansion (plan M6).
 *
 * The tool is the whole point of M6: without `create` + `add_material` the Agent
 * generates files that a person has to drag in by hand, so these tests build a
 * project exactly the way the Agent would and then check the result on disk.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
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
const { readProject, readMaterialIndex, writeMaterialIndex } = await import('../src/project/store.js')

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
  // Improvement plan 03, I-37: the level is measured when the material lands, so
  // "how loud is this" is answerable later without touching the file again.
  assert.equal(typeof index.materials[0].peakDb, 'number', 'the index records a peak')
  assert.equal(typeof index.materials[0].rmsDb, 'number', 'and an RMS')
  assert.equal(result.materials[0].peakDb, index.materials[0].peakDb, 'read reports the measured peak')
  assert.equal(result.materials[0].rmsDb, index.materials[0].rmsDb, 'and the measured RMS')
})

await test('read measures a material that was registered before levels existed', async () => {
  // Every project made before I-37 has materials with no level. Re-importing is
  // not an option — an external file cannot be re-rendered at all — so the read
  // path measures once and writes the numbers back.
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const first = index.materials[0]
  const knownPeak = first.peakDb
  delete first.peakDb
  delete first.rmsDb
  await writeMaterialIndex(workspaceRoot, projectId, index)

  const result = await call({ mode: 'read', projectId })
  assert.equal(result.ok, true)
  assert.equal(result.materials[0].peakDb, knownPeak, 'the read measured the same peak the import had')

  const repaired = await readMaterialIndex(workspaceRoot, projectId)
  assert.equal(typeof repaired.materials[0].rmsDb, 'number', 'and wrote the level back to the index')
})

await test('read reports an unmeasurable material as unknown, not as 0 dB', async () => {
  // A missing file must not fail the read: the project still describes an
  // arrangement, and this call is how a person finds out what is wrong with it.
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const entry = index.materials[0]
  const keptFile = entry.file
  const keptPeak = entry.peakDb
  const keptRms = entry.rmsDb
  entry.file = 'materials/does-not-exist.wav'
  entry.peakDb = null
  entry.rmsDb = null
  await writeMaterialIndex(workspaceRoot, projectId, index)

  try {
    const result = await call({ mode: 'read', projectId })
    assert.equal(result.ok, true, 'a missing file does not break mode:"read"')
    assert.equal(result.materials[0].rmsDb, null, 'an unmeasured material reads as unknown')
  } finally {
    const restored = await readMaterialIndex(workspaceRoot, projectId)
    restored.materials[0].file = keptFile
    restored.materials[0].peakDb = keptPeak
    restored.materials[0].rmsDb = keptRms
    await writeMaterialIndex(workspaceRoot, projectId, restored)
  }
})

await test('read reports how many clips use each material', async () => {
  // Improvement plan 03, I-40. 34 of one real project's 46 materials were 398 MB
  // of orphans, and nothing on screen or in the reply said so. The count is what
  // makes an orphan visible at all.
  const result = await call({ mode: 'read', projectId })
  const used = result.materials.filter((material) => material.referencedBy > 0)
  assert.ok(used.length > 0, 'a project with clips must report used material')
  for (const material of used) {
    const expected = result.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.material === material.id).length
    assert.equal(material.referencedBy, expected, `the count for ${material.id} must match the clips pointing at it`)
  }
})

await test('mode:"read" lists materials and points at the ones nobody uses', async () => {
  // An orphan gets a name and an instruction, or the Agent has no way to clean up.
  const tone = await writeTone('orphan-hint.wav', 1, 780)
  const added = await call({ mode: 'add_material', projectId, sourcePath: tone, kind: 'foley' })
  assert.equal(added.ok, true, added.error)
  const orphanId = added.materials.at(-1).id

  try {
    const definition = projectToolDefinition
    const value = await definition.execute({ mode: 'read', projectId }, makeExec())
    const text = definition.output.render({ mode: 'read' }, value).map((block) => block.text).join('\n')
    assert.match(text, /Materials \(\d+/, 'the reply lists the materials')
    assert.match(text, /dBFS RMS|level unknown/, 'with their measured level or an honest "unknown"')
    assert.match(text, /unused/, 'an orphan is marked as unused')
    assert.match(text, /target:"material"/, 'and the reply names the update that removes it')
    assert.ok(text.includes(orphanId), 'and it names the orphan by id, so the call can be made from the reply alone')
  } finally {
    await call({
      mode: 'update',
      projectId,
      changes: [{ target: 'material', materialId: orphanId, field: 'delete' }],
    })
  }
})

await test('target:"material" deletes an unused material and its files', async () => {
  const tone = await writeTone('orphan-a.wav', 1, 700)
  const added = await call({
    mode: 'add_material',
    projectId,
    sourcePath: tone,
    kind: 'foley',
  })
  assert.equal(added.ok, true)
  const materialId = added.materials.at(-1).id
  const file = join(workspaceRoot, '.anyaudio', 'projects', projectId, 'materials', `${materialId}.wav`)
  assert.equal(existsSync(file), true, 'the file is on disk before the delete')

  const removed = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'material', materialId, field: 'delete' }],
  })
  assert.equal(removed.ok, true, removed.error)
  assert.match(removed.applied[0], /删除素材/)
  assert.equal(existsSync(file), false, 'the audio file goes with it')

  const after = await readMaterialIndex(workspaceRoot, projectId)
  assert.equal(after.materials.some((row) => row.id === materialId), false, 'and the index loses the record')
  // The delete is a write like any other, so it leaves a history line.
  const project = await readProject(workspaceRoot, projectId)
  assert.match(project.history.at(-1).note, /删除素材/)
})

await test('target:"material" refuses to delete a material a clip still uses', async () => {
  const project = await readProject(workspaceRoot, projectId)
  const clip = project.tracks.flatMap((track) => track.items)[0]
  const result = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'material', materialId: clip.material, field: 'delete' }],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /still used by \d+ clip/)
  // The message has to name the clips, or the Agent sends the same call again.
  assert.match(result.error, /on "/, 'the refusal names the clips that hold it')
  const index = await readMaterialIndex(workspaceRoot, projectId)
  assert.ok(index.materials.some((row) => row.id === clip.material), 'nothing was removed')
})

await test('target:"material" rejects an unknown id and any field but delete', async () => {
  const missing = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'material', materialId: 'mat_nope', field: 'delete' }],
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /not in project/)

  const wrongField = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'material', materialId: 'mat_whatever', field: 'gainDb' }],
  })
  assert.equal(wrongField.ok, false)
  assert.match(wrongField.error, /material/)
  assert.match(wrongField.error, /never be edited/, 'the refusal explains that audio is not editable')
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
    changes: [{ target: 'track', trackId: track.id, field: 'muted', value: true }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.tracks[0].muted, true)
  assert.ok(result.applied.length === 1)
  const after = await readProject(workspaceRoot, projectId)
  const last = after.history.at(-1)
  assert.equal(last.by, 'agent')
  assert.match(last.note, /静音/)
  // Put it back so later tests are not affected by a muted first track.
  await call({ mode: 'update', projectId, changes: [{ target: 'track', trackId: track.id, field: 'muted', value: false }] })
})

await test('a track has no volume, pan or fx field any more', async () => {
  // Improvement plan 03, I-41. The refusal has to name what does exist, and point
  // at the clip, or the Agent guesses the same three fields again.
  const project = await readProject(workspaceRoot, projectId)
  for (const field of ['volumeDb', 'pan', 'fx']) {
    const result = await call({
      mode: 'update',
      projectId,
      changes: [{ target: 'track', trackId: project.tracks[0].id, field, value: field === 'fx' ? [] : 0 }],
    })
    assert.equal(result.ok, false, `${field} must be refused`)
    assert.match(result.error, /unknown track field/)
    assert.match(result.error, /only name, muted, solo or delete/)
    assert.match(result.error, /target:"clip"/, 'and the message says where those fields do live')
  }
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

await test('update keeps mute and solo from both being lit', async () => {
  // The mixer sums mute above solo: a track that is both is silent, while solo
  // silences every other track too — the whole project goes quiet. The clip bay's
  // buttons now clear the other flag, and the agent's update path has to agree,
  // or the same dead state comes back through the other door.
  const project = await readProject(workspaceRoot, projectId)
  const track = project.tracks[0]

  const soloed = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: track.id, field: 'solo', value: true }],
  })
  assert.equal(soloed.ok, true)
  assert.match(soloed.applied[0], /独奏/)

  const muted = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: track.id, field: 'muted', value: true }],
  })
  assert.equal(muted.ok, true)
  const afterMute = await readProject(workspaceRoot, projectId)
  const mutedTrack = afterMute.tracks.find((entry) => entry.id === track.id)
  assert.equal(mutedTrack.muted, true, 'muted')
  assert.equal(mutedTrack.solo, false, 'solo must clear, or every track is silent')
  assert.match(muted.applied[0], /同时取消独奏/)

  const soloAgain = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: track.id, field: 'solo', value: true }],
  })
  assert.equal(soloAgain.ok, true)
  const afterSolo = await readProject(workspaceRoot, projectId)
  const soloTrack = afterSolo.tracks.find((entry) => entry.id === track.id)
  assert.equal(soloTrack.solo, true, 'soloed')
  assert.equal(soloTrack.muted, false, 'mute must clear, or soloing it plays silence')
  assert.match(soloAgain.applied[0], /同时取消静音/)

  // Put the track back so later tests start from a clean slate.
  await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: track.id, field: 'solo', value: false }],
  })
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

await test('a clip change needs no trackId: the clip id finds its own track', async () => {
  // Improvement plan 03, I-45. A clip id is unique across the project, so the
  // track is a lookup, not an input. An Agent in a real session sent eight clip
  // changes with no trackId; all eight failed with "no such track: undefined" and
  // it kept retrying, because that message blamed the id it had got right.
  const project = await readProject(workspaceRoot, projectId)
  const track = project.tracks.find((entry) => entry.items.length > 0)
  const clip = track.items[0]
  const result = await call({
    mode: 'update',
    projectId,
    changes: [
      { target: 'clip', clipId: clip.id, field: 'gainDb', value: -4 },
      { target: 'clip', clipId: clip.id, field: 'pan', value: 0.25 },
      { target: 'clip', clipId: clip.id, field: 'fadeInSec', value: 0.5 },
    ],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.applied.length, 3, 'all three land, not just the first')
  const after = await readProject(workspaceRoot, projectId)
  const updated = after.tracks.find((entry) => entry.id === track.id).items.find((item) => item.id === clip.id)
  assert.equal(updated.gainDb, -4)
  assert.equal(updated.pan, 0.25)
  assert.equal(updated.fadeInSec, 0.5)
})

await test('an unknown clip id says so, instead of blaming a missing track', async () => {
  const result = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'clip', clipId: 'itm_nope', field: 'gainDb', value: 0 }],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /no such clip/)
  assert.match(result.error, /itm_nope/)
  assert.match(result.error, /trackId is optional/, 'and says the trackId it did not send was never needed')
  assert.doesNotMatch(result.error, /no such track/, 'the old message sent the Agent after the wrong id')
})

await test('a clip id sent as a trackId still gets the pointer', async () => {
  // I-27's message. It must keep working now that the clip branch resolves its
  // own track, or one confusion would replace another.
  const project = await readProject(workspaceRoot, projectId)
  const track = project.tracks.find((entry) => entry.items.length > 0)
  const clip = track.items[0]
  const result = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'track', trackId: clip.id, field: 'muted', value: false }],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /is a clip id, not a track id/)
  assert.match(result.error, /target:"clip"/)
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

await test('update reaches the project-level fields, which had no door before', async () => {
  // Improvement plan 02, I-06. `masterFaderDb` lives in project.json, but the only
  // update targets were track and clip, so an Agent asked to set the bus level had
  // to guess a track field — which is exactly what happened in a real session
  // ("unknown track field masterFaderDb"). The fader had no legal entrance.
  const result = await call({
    mode: 'update',
    projectId,
    changes: [
      { target: 'project', field: 'masterFaderDb', value: -6 },
      { target: 'project', field: 'name', value: '海边主题曲（终稿）' },
    ],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.applied.length, 2)
  const after = await readProject(workspaceRoot, projectId)
  assert.equal(after.masterFaderDb, -6, 'the bus fader is written')
  assert.equal(after.name, '海边主题曲（终稿）', 'and so is the name')

  // Every write is recorded, so the person can see what changed.
  const last = after.history.at(-1)
  assert.equal(last.by, 'agent')
  assert.match(last.note, /总线音量/)
  assert.match(last.note, /重命名工程/)
})

await test('update refuses to set normalizeGainDb by hand, and says why', async () => {
  // It is measured by the renderer on the first export and then frozen (spec
  // §10.2). A hand value would be silently overwritten, which is worse than a
  // refusal: the Agent would believe it had changed the loudness.
  const result = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'project', field: 'normalizeGainDb', value: 6 }],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /measured by the renderer/)
  assert.match(result.error, /masterFaderDb/, 'and names the field that does move the level')
  const after = await readProject(workspaceRoot, projectId)
  assert.notEqual(after.normalizeGainDb, 6, 'nothing was written')
})

await test('update lists the legal project fields when given a bogus one', async () => {
  const result = await call({
    mode: 'update',
    projectId,
    changes: [{ target: 'project', field: 'bogus', value: 1 }],
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown project field/)
  assert.match(result.error, /masterFaderDb/, 'the message has to name the legal fields, or the Agent guesses again')
  assert.match(result.error, /masterFx/, 'including the bus effect chain')
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
