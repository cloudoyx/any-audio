/**
 * Where a generated clip lands (improvement plan 02, I-02 / I-03).
 *
 * Two rules meet here, and the first version got both wrong in the same way — it
 * only ever looked at one track by name:
 *
 *  - A batch with no explicit start lands at 0s on every item, so the "is this
 *    track free?" check saw it busy and opened the next one. Ten effects became
 *    ten tracks, which is how a project ran into its 20-track limit and why an
 *    agent fell back to baking them into a single bed.
 *  - Narration was grouped by the speaker name the caller passed, so one voice
 *    whose fourth line started 0.22s before the third ended was split onto
 *    "旁白 2" — the same person, apparently on two tracks, for no reason a person
 *    could see.
 *
 * These cases drive attachClip directly. That is the layer that decides, it needs
 * no network, and a failure here is unambiguous: the wrong track or the wrong
 * time, not "the tool returned something".
 */
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(repoRoot, '.anyaudio', 'test-tmp-routing')
const workspaceRoot = join(scratch, 'workspace')

process.env.ANYAUDIO_STATE = join(scratch, 'state.json')
process.env.ANYAUDIO_CONFIG = join(scratch, 'config.json')

await rm(scratch, { recursive: true, force: true })
await mkdir(workspaceRoot, { recursive: true })

const { attachClip, familyEndSec, freeTrack, nextFreeStartSec, overlappingTrack, trackFamily } = await import('../src/project/attach.js')
const { createProject, readProject } = await import('../src/project/store.js')

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

/** A material object is all attachClip needs: it never reads the audio itself. */
let materialSeq = 0
function material(durationSec, label = 'clip') {
  materialSeq++
  return { id: `mat_${materialSeq}`, file: `materials/mat_${materialSeq}.wav`, durationSec, label }
}

let projectSeq = 0
async function freshProject() {
  projectSeq++
  const project = await createProject(workspaceRoot, { name: `routing-${projectSeq}` })
  return project.id
}

async function place(projectId, durationSec, options) {
  return attachClip(workspaceRoot, projectId, material(durationSec), options)
}

// --- I-02: a batch with no start chains ---------------------------------------

await test('ten effects without startSec land on one track, in order', async () => {
  const projectId = await freshProject()
  const placed = []
  for (let index = 0; index < 10; index++) {
    placed.push(await place(projectId, 0.5, { trackName: '音效 · 环境音', category: 'ambience', autoStart: true }))
  }
  const project = await readProject(workspaceRoot, projectId)
  assert.equal(project.tracks.length, 1, `ten effects should share one track, they took ${project.tracks.length}`)
  assert.equal(project.tracks[0].items.length, 10, `and all ten clips are on it, got ${project.tracks[0].items.length}`)
  const starts = project.tracks[0].items.map((item) => item.startSec)
  for (let index = 1; index < starts.length; index++) {
    assert.ok(starts[index] > starts[index - 1], `each clip follows the previous one, got ${starts.join(', ')}`)
    assert.ok(Math.abs(starts[index] - starts[index - 1] - 0.5) < 1e-6, `a 0.5s clip leaves the next one at +0.5s, got ${starts[index] - starts[index - 1]}`)
  }
  assert.equal(placed.length, 10)
  assert.ok(placed.every((entry) => entry.track.id === placed[0].track.id), 'every clip reported the same track')
})

await test('the append anchor spans the whole name family, not one track', async () => {
  // The two lookups that decide placement used to disagree about what "this
  // track" means: the anchor looked at one name, the free-track search at the
  // family. Fixing only one of them splits a batch that should stay together, so
  // this case asserts the family is what both of them see.
  const projectId = await freshProject()
  await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 0 })
  // Second clip overlaps → the family grows a second track.
  await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 0.5 })
  const twoTracks = await readProject(workspaceRoot, projectId)
  assert.equal(twoTracks.tracks.length, 2, `an overlap opens a second track, got ${twoTracks.tracks.length}`)
  assert.deepEqual(trackFamily(twoTracks, '音效 · 动效').map((track) => track.name), ['音效 · 动效', '音效 · 动效 2'])

  // Now an appended clip: it must go after the end of the *family*, which is the
  // later of the two tracks (1.5s), not after the first one (1.0s).
  assert.equal(familyEndSec(twoTracks, '音效 · 动效'), 1.5, 'the family ends where its last clip ends')
  const appended = await place(projectId, 0.5, { trackName: '音效 · 动效', category: 'foley', autoStart: true })
  assert.equal(appended.clip.startSec, 1.5, `the appended clip starts at the family end, got ${appended.clip.startSec}`)
  // It reuses the track that is free there instead of opening a third one.
  const three = await readProject(workspaceRoot, projectId)
  assert.equal(three.tracks.length, 2, `a clip that fits an existing track must not open another, got ${three.tracks.length}`)
})

await test('overlapping effects still get separate tracks', async () => {
  const projectId = await freshProject()
  await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 0 })
  const second = await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 0.2 })
  assert.equal(second.track.name, '音效 · 动效 2', `an overlap moves to the next track, got ${second.track.name}`)
  const project = await readProject(workspaceRoot, projectId)
  assert.equal(project.tracks.length, 2)
})

await test('a gap-free batch still reuses a track that has room', async () => {
  const projectId = await freshProject()
  await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 5 })
  const early = await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 0 })
  assert.equal(early.track.name, '音效 · 动效', `a clip that fits before an existing one shares the track, got ${early.track.name}`)
})

// --- I-03: narration groups by voice -----------------------------------------

await test('one voice whose lines touch stays on one track', async () => {
  // The measured case: line 3 runs 20.70 → 29.02, line 4 starts at 28.80, an
  // overlap of 0.22s. Before this change line 4 landed on "旁白 2".
  const projectId = await freshProject()
  const lengths = [5.92, 6.1, 8.32, 4.4, 5.0, 3.3, 6.6]
  const starts = [0, 6.5, 20.7, 28.8, 33.4, 39.2, 43.6]
  for (let index = 0; index < lengths.length; index++) {
    await place(projectId, lengths[index], {
      trackName: '旁白 · 晓晓',
      category: 'tts',
      startSec: starts[index],
      autoStart: false,
      allowOverlap: true,
    })
  }
  const project = await readProject(workspaceRoot, projectId)
  assert.equal(project.tracks.length, 1, `one voice is one track, it took ${project.tracks.length}`)
  assert.equal(project.tracks[0].items.length, 7, `all seven lines are on it, got ${project.tracks[0].items.length}`)
  assert.equal(project.tracks[0].category, 'tts')
})

await test('an appended narration line follows the family even when it overlaps', async () => {
  // autoStart and allowOverlap together: the line goes after what is already
  // there, and is allowed to touch it. Both have to agree on the same track.
  const projectId = await freshProject()
  const first = await place(projectId, 2, { trackName: '旁白 · 晓晓', category: 'tts', autoStart: true, allowOverlap: true })
  const second = await place(projectId, 2, { trackName: '旁白 · 晓晓', category: 'tts', autoStart: true, allowOverlap: true })
  assert.equal(first.clip.startSec, 0)
  assert.equal(second.clip.startSec, 2, `the next line starts where the last one ended, got ${second.clip.startSec}`)
  assert.equal(second.track.name, first.track.name, 'and on the same track')
})

await test('two voices get two tracks without anyone naming them', async () => {
  const projectId = await freshProject()
  await place(projectId, 2, { trackName: '旁白 · 晓晓', category: 'tts', autoStart: true, allowOverlap: true })
  await place(projectId, 2, { trackName: '旁白 · 云希', category: 'tts', autoStart: true, allowOverlap: true })
  const project = await readProject(workspaceRoot, projectId)
  assert.equal(project.tracks.length, 2, `two voices are two tracks, got ${project.tracks.length}`)
  assert.deepEqual(project.tracks.map((track) => track.name).sort(), ['旁白 · 云希', '旁白 · 晓晓'])
})

await test('an explicit role name starts its own family', async () => {
  const projectId = await freshProject()
  await place(projectId, 2, { trackName: '旁白 · 晓晓', category: 'tts', autoStart: true, allowOverlap: true })
  await place(projectId, 2, { trackName: '旁白 · 晓晓 · 老张', category: 'tts', autoStart: true, allowOverlap: true })
  const project = await readProject(workspaceRoot, projectId)
  assert.equal(project.tracks.length, 2, `a role override is a separate family, got ${project.tracks.length}`)
})

// --- the lookups agree ------------------------------------------------------

await test('overlappingTrack and freeTrack read the same family', async () => {
  // They answer different questions on purpose — "which track is free for this
  // span" versus "which track holds this family" — so they only agree on spans
  // that do not overlap. What must not diverge is the family they see: both have
  // to know that `旁白 · 晓晓 2` belongs to `旁白 · 晓晓`.
  const projectId = await freshProject()
  await place(projectId, 1, { trackName: '旁白 · 晓晓', category: 'tts', startSec: 0, allowOverlap: true })
  const project = await readProject(workspaceRoot, projectId)

  const head = overlappingTrack(project, { name: '旁白 · 晓晓', category: 'tts' })
  assert.equal(head.name, '旁白 · 晓晓', 'narration always returns the family head')

  // A span that fits the existing clip's track resolves to that same track.
  const fits = freeTrack({ ...project, tracks: project.tracks.map((t) => ({ ...t, items: [...t.items] })) },
    { name: '旁白 · 晓晓', category: 'tts', startSec: 2, endSec: 3 })
  assert.equal(fits.id, head.id, 'a free span reuses the head track rather than opening another')

  // A span that overlaps it opens the next family member — still the same family.
  const busy = freeTrack({ ...project, tracks: project.tracks.map((t) => ({ ...t, items: [...t.items] })) },
    { name: '旁白 · 晓晓', category: 'tts', startSec: 0.5, endSec: 1.5 })
  assert.equal(busy.name, '旁白 · 晓晓 2', `an overlapping span takes the next sibling, got ${busy.name}`)
  assert.equal(nextFreeStartSec(project.tracks[0]), 1, 'and the anchor is where the clip ends')
})

await test('a family is only ever the numbered siblings of one base name', async () => {
  const projectId = await freshProject()
  await place(projectId, 1, { trackName: '音效 · 环境音', category: 'ambience', startSec: 0 })
  await place(projectId, 1, { trackName: '音效 · 环境音 2', category: 'ambience', startSec: 0 })
  await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 0 })
  await place(projectId, 1, { trackName: '音乐', category: 'music', startSec: 0 })
  const project = await readProject(workspaceRoot, projectId)
  assert.deepEqual(trackFamily(project, '音效 · 环境音').map((track) => track.name), ['音效 · 环境音', '音效 · 环境音 2'])
  assert.deepEqual(trackFamily(project, '音效 · 动效').map((track) => track.name), ['音效 · 动效'])
  assert.deepEqual(trackFamily(project, '音乐').map((track) => track.name), ['音乐'])
  assert.deepEqual(trackFamily(project, '旁白').map((track) => track.name), [])
})

// --- I-08: the granularity rule, stated as three cases -----------------------

await test('effect granularity: same category never merges across an overlap', async () => {
  // The rule the person gave, as three cases in one project:
  //   same category, no overlap → one track
  //   same category, overlap    → a second track (环境音 2)
  //   different category        → separate tracks
  const projectId = await freshProject()
  // Three ambient effects, laid end to end: one track, three clips.
  for (let index = 0; index < 3; index++) {
    await place(projectId, 1, { trackName: '音效 · 环境音', category: 'ambience', startSec: index * 1 })
  }
  // Two ambient effects that overlap: the second opens 环境音 2.
  await place(projectId, 1, { trackName: '音效 · 环境音', category: 'ambience', startSec: 2.5 })
  // A foley and an "other" effect: their own families.
  await place(projectId, 1, { trackName: '音效 · 动效', category: 'foley', startSec: 0 })
  await place(projectId, 1, { trackName: '音效 · 其他', category: 'other', startSec: 0 })

  const project = await readProject(workspaceRoot, projectId)
  const byName = new Map(project.tracks.map((track) => [track.name, track]))
  assert.equal(byName.get('音效 · 环境音').items.length, 3, 'three effects laid end to end share the head track')
  assert.equal(byName.get('音效 · 环境音 2').items.length, 1, 'the one at 2.5s overlaps 2–3s, so it takes the sibling')
  assert.ok(byName.has('音效 · 动效'), 'foley keeps its own track')
  assert.ok(byName.has('音效 · 其他'), 'and "other" is not folded into either')
  assert.equal(project.tracks.length, 4, `expected 4 tracks, got ${project.tracks.map((t) => t.name).join(' | ')}`)
})

await rm(scratch, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
