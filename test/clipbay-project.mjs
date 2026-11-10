// M0 acceptance: the project model round-trips, rejects bad input and never
// loses a material that is still referenced. Runs entirely inside
// .anyaudio/test-tmp so the user's real projects are untouched.
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createProject,
  listProjects,
  readMaterialIndex,
  readProject,
  saveProject,
  writeMaterialIndex,
} from '../src/project/store.js'
import { deleteMaterial, findMaterial, materialPath, referencesFor, registerMaterial } from '../src/project/materials.js'
import { contentEndSec, migrate, validateProject, LIMITS, ProjectSchemaError } from '../src/project/schema.js'
import { projectDir, resolveInside, ProjectPathError, newItemId, newTrackId } from '../src/project/paths.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-project')
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

const ws = join(tmpDir, 'workspace')

await test('create → save → read back gives the same project', async () => {
  const created = await createProject(ws, { name: '海边主题曲' })
  assert(created.id, 'a project id is generated')
  assert(created.schemaVersion === 1, 'schemaVersion is 1')
  assert(created.name === '海边主题曲', 'the display name is kept')
  assert(existsSync(join(projectDir(ws, created.id), 'project.json')), 'project.json exists')
  assert(existsSync(join(projectDir(ws, created.id), 'materials', 'index.json')), 'materials/index.json exists')

  created.tracks.push({
    id: newTrackId(),
    name: '鼓组',
    category: 'music',
    volumeDb: -2,
    pan: 0.25,
    muted: false,
    solo: false,
    items: [
      {
        id: newItemId(),
        material: 'mat_aaa',
        startSec: 12,
        inSec: 0,
        outSec: 8,
        gainDb: -1.5,
        pan: 0,
        fadeInSec: 0.05,
        fadeOutSec: 0.3,
        muted: false,
        label: 'Verse',
      },
    ],
  })
  const saved = await saveProject(ws, created, { by: 'user', note: 'added a drum track' })
  assert(saved.durationSec === 20, `durationSec is content-derived, got ${saved.durationSec}`)
  assert(saved.history.at(-1).note === 'added a drum track', 'the history entry was appended')

  const reread = await readProject(ws, created.id)
  assert(reread.tracks.length === 1, 'one track came back')
  assert(reread.tracks[0].items[0].outSec === 8, 'item timing survived')
  assert(reread.tracks[0].pan === 0.25, 'track pan survived')
  assert(reread.modifiedAt === saved.modifiedAt, 'modifiedAt survived')
})

await test('a missing schemaVersion is read as v1 and upgraded on save', async () => {
  const created = await createProject(ws, { name: 'legacy' })
  const file = join(projectDir(ws, created.id), 'project.json')
  const raw = JSON.parse(await readFile(file, 'utf8'))
  delete raw.schemaVersion
  delete raw.masterFaderDb
  await writeFile(file, JSON.stringify(raw, null, 2), 'utf8')

  const reread = await readProject(ws, created.id)
  assert(reread.schemaVersion === 1, 'migrated to v1')
  assert(reread.masterFaderDb === 0, 'a missing field was filled with its default')
})

await test('newer schemaVersion is rejected instead of guessed', async () => {
  let error = null
  try {
    migrate({ id: 'prj_x', name: 'x', schemaVersion: 2, tracks: [] })
  } catch (caught) {
    error = caught
  }
  assert(error && /newer than this plugin understands/.test(error.message), 'v2 must not be silently downgraded')
  assert(migrate({ id: 'prj_x', name: 'x', schemaVersion: 1, tracks: [] }).schemaVersion === 1, 'v1 still migrates')
})

await test('illegal fields are rejected, not repaired', async () => {
  const created = await createProject(ws, { name: 'strict' })
  const bad = structuredClone(created)

  bad.tracks = [{ id: 'trk_a', name: 'a', category: 'nope', volumeDb: 0, pan: 0, muted: false, solo: false, items: [] }]
  await rejects(() => saveProject(ws, bad), /category must be one of/, 'unknown category')

  const missingOut = structuredClone(created)
  missingOut.tracks = [{
    id: 'trk_a', name: 'a', category: 'music', volumeDb: 0, pan: 0, muted: false, solo: false,
    items: [{ id: 'itm_a', material: 'mat_a', startSec: 0, inSec: 2, outSec: 2, gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: '' }],
  }]
  await rejects(() => saveProject(ws, missingOut), /outSec must be greater than inSec/, 'empty item range')

  const notANumber = structuredClone(created)
  notANumber.normalizeGainDb = 'loud'
  await rejects(() => saveProject(ws, notANumber), /normalizeGainDb must be a finite number/, 'string gain')

  const tooManyTracks = structuredClone(created)
  tooManyTracks.tracks = Array.from({ length: LIMITS.tracks + 1 }, (_, index) => ({
    id: `trk_${index}`, name: `t${index}`, category: 'other', volumeDb: 0, pan: 0, muted: false, solo: false, items: [],
  }))
  await rejects(() => saveProject(ws, tooManyTracks), new RegExp(`at most ${LIMITS.tracks} tracks`), 'track limit')

  const tooLong = structuredClone(created)
  tooLong.tracks = [{
    id: 'trk_long', name: 'long', category: 'other', volumeDb: 0, pan: 0, muted: false, solo: false,
    items: [{ id: 'itm_long', material: 'mat_a', startSec: 900, inSec: 0, outSec: 1, gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: '' }],
  }]
  await rejects(() => saveProject(ws, tooLong), /at most 15 minutes/, 'duration limit')
})

await test('a duration longer than 15 minutes is refused even when split across tracks', async () => {
  const created = await createProject(ws, { name: 'long' })
  created.tracks = [0, 1, 2].map((index) => ({
    id: `trk_${index}`, name: `t${index}`, category: 'other', volumeDb: 0, pan: 0, muted: false, solo: false,
    items: [{ id: `itm_${index}`, material: 'mat_a', startSec: 890, inSec: 0, outSec: 20, gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: '' }],
  }))
  await rejects(() => saveProject(ws, created), /at most 15 minutes/, 'aggregate duration')
})

await test('a material used by two clips survives deleting one clip', async () => {
  const created = await createProject(ws, { name: 'refs' })
  const dir = projectDir(ws, created.id)
  await writeFile(join(dir, 'materials', 'mat_aa.wav'), Buffer.alloc(64), 'utf8')
  await registerMaterial(ws, created.id, {
    id: 'mat_aa', file: 'materials/mat_aa.wav', durationSec: 4, sampleRate: 48000, channels: 2, kind: 'sfx', bytes: 64,
    source: { kind: 'generated', snapshot: 'sources/mat_aa.sfx.json', tool: 'anyaudio_sfx' },
  })

  created.tracks = [{
    id: 'trk_1', name: '动效', category: 'foley', volumeDb: 0, pan: 0, muted: false, solo: false,
    items: [
      { id: 'itm_intro', material: 'mat_aa', startSec: 0, inSec: 0, outSec: 4, gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: 'Intro' },
      { id: 'itm_outro', material: 'mat_aa', startSec: 60, inSec: 0, outSec: 4, gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: 'Outro' },
    ],
  }]
  let project = await saveProject(ws, created)

  await rejects(
    () => deleteMaterial(ws, created.id, 'mat_aa'),
    /still used by 2 clips/,
    'deleting a referenced material',
  )

  project.tracks[0].items = project.tracks[0].items.filter((item) => item.id !== 'itm_intro')
  project = await saveProject(ws, project)
  assert(referencesFor(project, 'mat_aa').length === 1, 'one reference left')
  await rejects(() => deleteMaterial(ws, created.id, 'mat_aa'), /still used by 1 clip/, 'still referenced')

  project.tracks[0].items = []
  await saveProject(ws, project)
  const result = await deleteMaterial(ws, created.id, 'mat_aa')
  assert(result.deleted, 'the material was deleted once nothing referenced it')
  assert(!existsSync(join(dir, 'materials', 'mat_aa.wav')), 'the material file went away')
  const index = await readMaterialIndex(ws, created.id)
  assert(index.materials.length === 0, 'the index entry went away')
})

await test('the material index keeps source data, not arrangement', async () => {
  const created = await createProject(ws, { name: 'index' })
  await writeFile(join(projectDir(ws, created.id), 'materials', 'mat_bb.wav'), Buffer.alloc(32), 'utf8')
  await registerMaterial(ws, created.id, {
    id: 'mat_bb', file: 'materials/mat_bb.wav', durationSec: 2, sampleRate: 48000, channels: 2, kind: 'imported', bytes: 32,
    source: { kind: 'imported', originalName: '夜雨.mp3', originalFormat: 'mp3', importedAt: '2026-11-05T19:05:00Z' },
  })
  const index = await readMaterialIndex(ws, created.id)
  const entry = findMaterial(index, 'mat_bb')
  assert(entry, 'the entry was stored')
  assert(entry.source.originalName === '夜雨.mp3', 'the original name is kept')
  assert(!('startSec' in entry), 'the index must not hold arrangement')
  const path = await materialPath(ws, created.id, 'mat_bb')
  assert(isAbsolute(path) && existsSync(path), 'materialPath resolves an existing file')

  await rejects(
    () => registerMaterial(ws, created.id, { id: 'mat_bb', file: 'materials/mat_bb.wav', durationSec: 2, kind: 'imported' }),
    /already exists/,
    'duplicate material id',
  )
  await rejects(
    () => registerMaterial(ws, created.id, { id: 'mat_cc', file: '../outside.wav', durationSec: 2, kind: 'imported' }),
    /must not escape the project folder/,
    'a material file outside the project',
  )
})

await test('the index can be rewritten wholesale', async () => {
  const created = await createProject(ws, { name: 'rewrite' })
  await writeMaterialIndex(ws, created.id, { materials: [{ id: 'mat_z', file: 'materials/mat_z.wav', durationSec: 1, kind: 'tts' }] })
  const index = await readMaterialIndex(ws, created.id)
  assert(index.materials.length === 1 && index.materials[0].id === 'mat_z', 'the index was replaced')
})

await test('listing a workspace shows real projects, newest first', async () => {
  const rows = await listProjects(ws)
  assert(rows.length >= 4, `expected several projects, got ${rows.length}`)
  assert(rows.every((row) => row.id && typeof row.trackCount === 'number'), 'rows carry the summary fields')
  const times = rows.map((row) => row.mtimeMs)
  assert(times.every((value, index) => index === 0 || times[index - 1] >= value), 'newest first')
})

await test('an unknown project id reads as a clear error', async () => {
  await rejects(() => readProject(ws, 'prj_missing'), /no such project/, 'missing project')
  await rejects(() => readProject(ws, '../escape'), /may only contain/, 'path traversal in the id')
})

await test('resolveInside refuses anything outside the project folder', async () => {
  const dir = projectDir(ws, 'prj_x')
  const inside = resolveInside(dir, 'materials/mat_1.wav')
  assert(inside.startsWith(resolve(dir)), 'a normal path stays inside')
  for (const bad of ['../x.wav', '../../x.wav', 'C:/Windows/x.wav', '/etc/x.wav', 'materials/../../x.wav']) {
    let error = null
    try {
      resolveInside(dir, bad)
    } catch (caught) {
      error = caught
    }
    assert(error instanceof ProjectPathError, `${bad} must be refused`)
  }
})

await test('contentEndSec ignores the stored durationSec and follows the content', async () => {
  const project = migrate({
    id: 'prj_d', name: 'd', schemaVersion: 1, durationSec: 999,
    tracks: [{
      id: 'trk_1', name: 'a', category: 'other', volumeDb: 0, pan: 0, muted: false, solo: false,
      items: [{ id: 'itm_1', material: 'mat_a', startSec: 10, inSec: 1, outSec: 4, gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: '' }],
    }],
  })
  assert(contentEndSec(project) === 13, `expected 13, got ${contentEndSec(project)}`)
  project.video = { path: 'video/a.mp4', durationSec: 30, locked: true }
  assert(contentEndSec(project) === 30, 'a longer video wins')
  validateProject(project)
})

await test('an invalid project never leaves a temporary file behind', async () => {
  const created = await createProject(ws, { name: 'atomic' })
  const dir = projectDir(ws, created.id)
  const broken = structuredClone(created)
  broken.sampleRate = -1
  await rejects(() => saveProject(ws, broken), /sampleRate must be within|sampleRate must be between/, 'bad sample rate')
  const names = await readdir(dir)
  assert(!names.some((name) => name.includes('.tmp-')), `no temp files expected, found ${names.join(',')}`)
})

await test('a ProjectSchemaError is thrown for structural mistakes', async () => {
  let error = null
  try {
    validateProject({ schemaVersion: 1 })
  } catch (caught) {
    error = caught
  }
  assert(error instanceof ProjectSchemaError, 'structural errors are ProjectSchemaError')
})

await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) {
  const leftover = await readdir(anyaudioDir).catch(() => [])
  if (leftover.length === 0) await rm(anyaudioDir, { recursive: true, force: true })
}

await test('an empty effect chain never reaches project.json', async () => {
  // Improvement plan 03, I-49. The browser's serializer already omits an empty
  // chain; the host wrote the in-memory default, so a project touched by the Agent
  // carried `"fx": []` on every track and one saved by hand carried none.
  const { saveProject, readProject: readBack } = await import('../src/project/store.js')
  const { defaultItem, defaultTrack, emptyProject: makeEmpty } = await import('../src/project/schema.js')
  const project = await createProject(ws, { name: 'fx-cleaning' })
  const draft = makeEmpty({ id: project.id, name: project.name })
  draft.tracks = [{
    ...defaultTrack('trk_clean', 'Clean'),
    items: [{ ...defaultItem('itm_clean', 'mat_none'), startSec: 0, inSec: 0, outSec: 1 }],
  }]
  await saveProject(ws, draft, { by: 'agent', note: 'test' })
  const path = join(ws, '.anyaudio', 'projects', project.id, 'project.json')
  const raw = await readFile(path, 'utf8')
  assert(!/"fx":\s*\[\]/.test(raw), 'no empty fx array may be written')
  assert(!/"masterFx":\s*\[\]/.test(raw), 'nor an empty masterFx')

  // A real chain still goes to disk untouched.
  draft.masterFx = [{ type: 'limiter', ceilingDb: -1 }]
  draft.tracks[0].items[0].fx = [{ type: 'eq', bands: [{ type: 'peaking', freqHz: 1000, gainDb: 3, q: 1 }] }]
  await saveProject(ws, draft, { by: 'agent', note: 'with fx' })
  const withFx = await readFile(path, 'utf8')
  assert(/"masterFx":\s*\[/.test(withFx), 'the bus chain is written')
  assert(/"fx":\s*\[/.test(withFx), 'and the clip chain is written')

  // And the file reads back with the defaults the code expects in memory.
  const loaded = await readBack(ws, project.id)
  assert(loaded.tracks[0].id === 'trk_clean', 'the project reads back')
  await rm(join(ws, '.anyaudio', 'projects', project.id), { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
