// M1 acceptance: catalog / inspect / {sound} placement.
//
// The library is a scratch directory under .anyaudio/test-tmp with generated
// MP3 fixtures, so this test never reads the user's real packs and never needs
// the real 237-sound pack to exist.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerAllTools } from '../src/tools/index.js'
import { findFfmpeg, runFfmpeg } from '../src/tools/shared.js'
import { createProject, readProject } from '../src/project/store.js'
import { readMaterialIndex } from '../src/project/store.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-sfxlib-tool')
await rm(tmpDir, { recursive: true, force: true })
await mkdir(tmpDir, { recursive: true })

const libraryRoot = join(tmpDir, 'sfx')
process.env.ANYAUDIO_SFX_DIR = libraryRoot
process.env.ANYAUDIO_STATE = join(tmpDir, 'state.json')
process.env.ANYAUDIO_CONFIG = join(tmpDir, 'config.json')

const ffmpeg = findFfmpeg()
if (!ffmpeg) {
  console.log('SKIP: ffmpeg is not available, so a library sound cannot be converted')
  process.exit(0)
}

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

/** A short MP3 fixture: a 2-second tone, so every sound has a real length. */
async function makeMp3(path, seconds = 2, frequency = 440) {
  await mkdir(dirname(path), { recursive: true })
  await runFfmpeg(ffmpeg.command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-ac', '2', '-ar', '48000', '-b:a', '128k', '-c:a', 'libmp3lame',
    path,
  ])
  return path
}

async function writePack(packId, sounds, extra = {}) {
  const dir = join(libraryRoot, packId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: packId,
    name: extra.name ?? packId,
    version: '1.0.0',
    license: extra.license ?? 'CC0-1.0',
    format: 'mp3',
    sounds,
  }, null, 2)}\n`, 'utf8')
  return dir
}

const tools = new Map()
registerAllTools({
  tools: { register: (definition) => tools.set(definition.name, definition) },
  logger: { info: () => {} },
  get: () => undefined,
})
const sfx = tools.get('anyaudio_sfx')
const exec = { agent: { workspaceRoot: root } }

let projectSeq = 0
async function freshProject() {
  projectSeq++
  const created = await createProject(root, { name: `sfxlib-tool-${projectSeq}` })
  return created.id
}

// ---------------------------------------------------------------------------
// Fixtures: one priority pack (BaseSFX) and one normal pack (UserSFX1).

const baseDir = await writePack('BaseSFX', [
  { name: '门-木门-敲门-三下-中等', type: 'foley', durationSec: 2, peakPosSec: 0.8, file: 'FOL/门-木门-敲门-三下-中等.mp3' },
  { name: '门-铁门-关门-重-混响大', type: 'foley', durationSec: 2, peakPosSec: 0.6, file: 'FOL/门-铁门-关门-重-混响大.mp3' },
  { name: '门-木门-吱呀一声', type: 'foley', durationSec: 2, peakPosSec: 0.4, file: 'FOL/门-木门-吱呀一声.mp3' },
  { name: '室外-森林-夜晚-虫鸣-中等', type: 'ambience', durationSec: 2, file: 'AMB/室外-森林-夜晚-虫鸣-中等.mp3' },
  { name: '转场-Whoosh-短而急', type: 'dsn', durationSec: 2, peakPosSec: 0.3, file: 'DSN/转场-Whoosh-短而急.mp3' },
], { name: '基础音效包' })
await makeMp3(join(baseDir, 'FOL/门-木门-敲门-三下-中等.mp3'), 2, 440)
await makeMp3(join(baseDir, 'FOL/门-铁门-关门-重-混响大.mp3'), 2, 460)
await makeMp3(join(baseDir, 'FOL/门-木门-吱呀一声.mp3'), 2, 480)
await makeMp3(join(baseDir, 'AMB/室外-森林-夜晚-虫鸣-中等.mp3'), 2, 220)
await makeMp3(join(baseDir, 'DSN/转场-Whoosh-短而急.mp3'), 2, 880)

const userDir = await writePack('UserSFX1', [
  { name: '打铁', type: 'foley', durationSec: 2, peakPosSec: 0.5, file: 'FOL/打铁.mp3' },
  { name: '断骨', type: 'foley', durationSec: 2, peakPosSec: 0.5, file: 'FOL/断骨.mp3' },
], { name: '用户素材包', license: '' })
await makeMp3(join(userDir, 'FOL/打铁.mp3'), 2, 330)
await makeMp3(join(userDir, 'FOL/断骨.mp3'), 2, 550)

// ---------------------------------------------------------------------------

await test('catalog expands the priority pack and summarises the normal one', async () => {
  const result = await sfx.execute({ action: 'catalog' }, exec)
  assert(result.action === 'catalog', `action was ${result.action}`)
  const base = result.library.find((pack) => pack.id === 'BaseSFX')
  const user = result.library.find((pack) => pack.id === 'UserSFX1')
  assert(base, 'BaseSFX should be listed')
  assert(user, 'UserSFX1 should be listed')
  assert(base.priority === true, 'BaseSFX should be priority by default')
  assert(user.priority === false, 'UserSFX1 should be normal by default')
  assert(base.count === 5, `BaseSFX count was ${base.count}`)
  assert(base.groups.foley.includes('门-木门-敲门-三下-中等'), 'the foley names should be expanded')
  assert(base.groups.ambience.includes('室外-森林-夜晚-虫鸣-中等'), 'the ambience names should be expanded')
  assert(base.groups.dsn.includes('转场-Whoosh-短而急'), 'the dsn names should be expanded')
  assert(Object.keys(user.groups).length === 0, 'a normal pack should not expand its names')
  // The preset catalog is still there, untouched.
  assert(result.presets.length >= 40, `the preset catalog shrank to ${result.presets.length}`)
})

await test('catalog renders the library before the presets', async () => {
  const result = await sfx.execute({ action: 'catalog' }, exec)
  const text = sfx.output.render({}, result).map((block) => block.text).join('\n')
  const libraryAt = text.indexOf('基础音效包')
  const presetAt = text.indexOf('SoundFont 内置采样')
  assert(libraryAt >= 0, 'the library section should be rendered')
  assert(presetAt > libraryAt, 'the presets should come after the library')
  assert(text.includes('门-木门-敲门-三下-中等'), 'the priority names should be rendered')
  assert(text.includes('UserSFX1（普通，2 条）'), 'the normal pack should be one summary line')
  assert(!text.includes('打铁'), 'a normal pack must not expand its names')
})

await test('inspect returns the fields of the named sounds', async () => {
  const result = await sfx.execute({ action: 'inspect', names: ['门-木门-敲门-三下-中等', '室外-森林-夜晚-虫鸣-中等'] }, exec)
  assert(result.action === 'inspect', `action was ${result.action}`)
  assert(result.sounds.length === 2, `expected 2 sounds, got ${result.sounds.length}`)
  const knock = result.sounds[0]
  assert(knock.name === '门-木门-敲门-三下-中等', `name was ${knock.name}`)
  assert(knock.type === 'foley', `type was ${knock.type}`)
  assert(knock.durationSec === 2, `durationSec was ${knock.durationSec}`)
  assert(knock.peakPosSec === 0.8, `peakPosSec was ${knock.peakPosSec}`)
  assert(knock.packId === 'BaseSFX', `packId was ${knock.packId}`)
  const ambience = result.sounds[1]
  assert(ambience.peakPosSec === undefined, 'ambience should carry no peakPosSec')
})

await test('inspect renders one line per sound', async () => {
  const result = await sfx.execute({ action: 'inspect', names: ['门-木门-敲门-三下-中等'] }, exec)
  const text = sfx.output.render({}, result).map((block) => block.text).join('\n')
  assert(/门-木门-敲门-三下-中等 \| 动效 \| 2\.00s \| 主峰 0\.800s/.test(text), `rendered: ${text}`)
})

await test('{sound} lands one material and one clip', async () => {
  const projectId = await freshProject()
  const result = await sfx.execute({
    projectId,
    items: [{ sound: '门-木门-敲门-三下-中等', startSec: 1.5, gainDb: -6 }],
  }, exec)
  assert(result.materials.length === 1, `expected 1 material, got ${result.materials.length}`)
  const material = result.materials[0]
  assert(material.sound === 'BaseSFX/门-木门-敲门-三下-中等', `sound was ${material.sound}`)
  assert(material.category === '动效', `category was ${material.category}`)

  const index = await readMaterialIndex(root, projectId)
  assert(index.materials.length === 1, `expected 1 material in the index, got ${index.materials.length}`)
  const entry = index.materials[0]
  assert(entry.kind === 'library', `kind was ${entry.kind}`)
  assert(entry.source.packId === 'BaseSFX', `source.packId was ${entry.source.packId}`)
  assert(entry.source.soundName === '门-木门-敲门-三下-中等', `source.soundName was ${entry.source.soundName}`)

  const project = await readProject(root, projectId)
  const clips = project.tracks.flatMap((track) => track.items)
  assert(clips.length === 1, `expected 1 clip, got ${clips.length}`)
  assert(clips[0].startSec === 1.5, `startSec was ${clips[0].startSec}`)
  assert(clips[0].gainDb === -6, `gainDb was ${clips[0].gainDb}`)
})

await test('only the used sound is copied into the project, not the pack', async () => {
  const projectId = await freshProject()
  await sfx.execute({ projectId, items: [{ sound: '门-木门-敲门-三下-中等' }] }, exec)
  const index = await readMaterialIndex(root, projectId)
  assert(index.materials.length === 1, `expected 1 material, got ${index.materials.length}`)
  const project = await readProject(root, projectId)
  const clips = project.tracks.flatMap((track) => track.items)
  assert(clips.length === 1, `expected 1 clip, got ${clips.length}`)
})

await test('the same sound placed three times is three clips and one material', async () => {
  const projectId = await freshProject()
  await sfx.execute({
    projectId,
    items: [
      { sound: '门-木门-敲门-三下-中等', startSec: 0 },
      { sound: '门-木门-敲门-三下-中等', startSec: 0.4 },
      { sound: '门-木门-敲门-三下-中等', startSec: 0.8 },
    ],
  }, exec)
  const index = await readMaterialIndex(root, projectId)
  assert(index.materials.length === 1, `expected 1 material, got ${index.materials.length}`)
  const project = await readProject(root, projectId)
  const clips = project.tracks.flatMap((track) => track.items)
  assert(clips.length === 3, `expected 3 clips, got ${clips.length}`)
  assert(clips.map((clip) => clip.startSec).join(',') === '0,0.4,0.8', `starts were ${clips.map((clip) => clip.startSec).join(',')}`)
})

await test('three placements at three gains still share one material', async () => {
  const projectId = await freshProject()
  await sfx.execute({
    projectId,
    items: [
      { sound: '门-木门-敲门-三下-中等', startSec: 0, gainDb: 0 },
      { sound: '门-木门-敲门-三下-中等', startSec: 3, gainDb: -6 },
      { sound: '门-木门-敲门-三下-中等', startSec: 6, gainDb: -12 },
    ],
  }, exec)
  const index = await readMaterialIndex(root, projectId)
  assert(index.materials.length === 1, `expected 1 material, got ${index.materials.length}`)
  const project = await readProject(root, projectId)
  const clips = project.tracks.flatMap((track) => track.items)
  assert(clips.length === 3, `expected 3 clips, got ${clips.length}`)
  assert(clips.map((clip) => clip.gainDb).sort((a, b) => a - b).join(',') === '-12,-6,0', `gains were ${clips.map((clip) => clip.gainDb).join(',')}`)
})

await test('a missing name reports the closest candidates', async () => {
  const projectId = await freshProject()
  const error = await rejects(
    () => sfx.execute({ projectId, items: [{ sound: '门-木门-敲门-三下' }] }, exec),
    /closest:/,
    'a near miss should offer candidates',
  )
  assert(/三下-中等/.test(error.message), `the candidate should be the real name: ${error.message}`)
})

await test('{type:"wind"} without a length still needs durationSec', async () => {
  const projectId = await freshProject()
  const error = await rejects(
    () => sfx.execute({ projectId, items: [{ type: 'wind' }] }, exec),
    /needs durationSec/,
    'a procedural generator must still demand a length',
  )
  assert(!/library/i.test(error.message), 'the procedural error must not mention the library')
})

await test('{preset:"rain"} still goes through the SoundFont branch', async () => {
  const projectId = await freshProject()
  const result = await sfx.execute({ projectId, items: [{ preset: 'rain', durationSec: 1 }] }, exec)
  assert(result.materials.length === 1, `expected 1 material, got ${result.materials.length}`)
  assert(result.materials[0].preset === 'rain', `preset was ${result.materials[0].preset}`)
  assert(result.materials[0].sound === undefined, 'a preset must not be reported as a library sound')
})

await test('with no processing parameters the material is the whole recording', async () => {
  const projectId = await freshProject()
  const result = await sfx.execute({ projectId, items: [{ sound: '门-木门-敲门-三下-中等' }] }, exec)
  const material = result.materials[0]
  // The fixture is a 2-second MP3; the converted WAV must be the whole thing.
  assert(Math.abs(material.durationSec - 2) < 0.1, `duration was ${material.durationSec}s, expected about 2s`)
  const project = await readProject(root, projectId)
  const clip = project.tracks.flatMap((track) => track.items)[0]
  assert(Math.abs(clip.outSec - clip.inSec - 2) < 0.1, `the clip should use the whole sound, got ${clip.outSec - clip.inSec}s`)
})

await test('outSec trims the clip without touching the material', async () => {
  const projectId = await freshProject()
  const result = await sfx.execute({ projectId, items: [{ sound: '门-木门-敲门-三下-中等', outSec: 0.8 }] }, exec)
  const material = result.materials[0]
  assert(Math.abs(material.durationSec - 2) < 0.1, `the material should stay whole, got ${material.durationSec}s`)
  const project = await readProject(root, projectId)
  const clip = project.tracks.flatMap((track) => track.items)[0]
  assert(Math.abs(clip.outSec - 0.8) < 1e-6, `the clip should be trimmed to 0.8s, got ${clip.outSec}s`)
})

await test('durationSec on a library sound is the clip length, not a rewrite', async () => {
  const projectId = await freshProject()
  const result = await sfx.execute({ projectId, items: [{ sound: '门-木门-敲门-三下-中等', durationSec: 0.5 }] }, exec)
  const material = result.materials[0]
  assert(Math.abs(material.durationSec - 2) < 0.1, `the material should stay whole, got ${material.durationSec}s`)
  const project = await readProject(root, projectId)
  const clip = project.tracks.flatMap((track) => track.items)[0]
  assert(Math.abs(clip.outSec - 0.5) < 1e-6, `the clip should be 0.5s, got ${clip.outSec}s`)
})

await test('fades and pan land on the clip', async () => {
  const projectId = await freshProject()
  await sfx.execute({
    projectId,
    items: [{ sound: '门-木门-敲门-三下-中等', fadeInSec: 0.1, fadeOutSec: 0.2, pan: -0.5 }],
  }, exec)
  const project = await readProject(root, projectId)
  const clip = project.tracks.flatMap((track) => track.items)[0]
  assert(clip.fadeInSec === 0.1, `fadeInSec was ${clip.fadeInSec}`)
  assert(clip.fadeOutSec === 0.2, `fadeOutSec was ${clip.fadeOutSec}`)
  assert(clip.pan === -0.5, `pan was ${clip.pan}`)
})

await test('a normal pack sound resolves through search and places', async () => {
  const found = await sfx.execute({ action: 'search', query: '打铁' }, exec)
  assert(found.action === 'search', `action was ${found.action}`)
  assert(found.total === 1, `expected 1 hit, got ${found.total}`)
  assert(found.results[0].name === '打铁', `name was ${found.results[0].name}`)
  assert(found.results[0].packId === 'UserSFX1', `packId was ${found.results[0].packId}`)
  assert(found.results[0].priority === false, 'a normal pack hit should not be marked priority')

  const projectId = await freshProject()
  const result = await sfx.execute({ projectId, items: [{ sound: '打铁' }] }, exec)
  assert(result.materials[0].sound === 'UserSFX1/打铁', `sound was ${result.materials[0].sound}`)
})

await test('search finds a word in the middle and at the end of a name', async () => {
  const middle = await sfx.execute({ action: 'search', query: '森林' }, exec)
  assert(middle.total === 1, `expected 1 hit for 森林, got ${middle.total}`)
  const end = await sfx.execute({ action: 'search', query: '虫鸣' }, exec)
  assert(end.total === 1, `expected 1 hit for 虫鸣, got ${end.total}`)
  assert(end.results[0].name === '室外-森林-夜晚-虫鸣-中等', `name was ${end.results[0].name}`)
})

await test('search returns nothing for a phrase whose characters are out of order', async () => {
  const phrase = await sfx.execute({ action: 'search', query: '用力敲门' }, exec)
  assert(phrase.total === 0, `expected 0 hits, got ${phrase.total}`)
  const word = await sfx.execute({ action: 'search', query: '敲门' }, exec)
  assert(word.total === 1, `expected 1 hit for 敲门, got ${word.total}`)
})

await test('search marks a priority-pack hit and reports truncation', async () => {
  const hit = await sfx.execute({ action: 'search', query: '敲门' }, exec)
  assert(hit.results[0].priority === true, 'a BaseSFX hit should be marked priority')
  const limited = await sfx.execute({ action: 'search', query: '门', limit: 1 }, exec)
  assert(limited.shown === 1, `shown was ${limited.shown}`)
  assert(limited.truncated === true, 'a truncated result should say so')
  assert(limited.total >= 1, `total was ${limited.total}`)
})

await test('search with no hits says so instead of returning an empty list', async () => {
  const result = await sfx.execute({ action: 'search', query: '完全不存在的东西' }, exec)
  assert(result.total === 0, `total was ${result.total}`)
  const text = sfx.output.render({}, result).map((block) => block.text).join('\n')
  assert(/库里没有匹配的名字/.test(text), `rendered: ${text}`)
})

await test('the tool description carries the placement guidance', async () => {
  const description = sfx.description
  assert(/one name is one recording/i.test(description), 'the description should say a name is one recording')
  assert(/place several clips offset/i.test(description), 'the description should say to place several clips')
  assert(/trim it with inSec\/outSec/i.test(description), 'the description should name the trimming parameters')
  assert(/never splits a recording on its own/i.test(description), 'the description should say the tool does not split')
  assert(/does exactly what you ask/i.test(description), 'the description should say the tool executes parameters')
})

await test('the items parameter names the three sources and the clip parameters', async () => {
  const items = sfx.parameters.properties.items.description
  assert(/\{sound:/.test(items), 'items should show the sound form')
  assert(/\{preset:/.test(items), 'items should show the preset form')
  assert(/\{type:/.test(items), 'items should show the type form')
  assert(/inSec\/outSec/.test(items), 'items should name inSec/outSec')
  assert(/gainDb/.test(items), 'items should name gainDb')
})

await test('a library sound needs no durationSec', async () => {
  const projectId = await freshProject()
  const result = await sfx.execute({ projectId, items: [{ sound: '转场-Whoosh-短而急' }] }, exec)
  assert(result.materials.length === 1, `expected 1 material, got ${result.materials.length}`)
})

await test('the library is not touched by a placement', async () => {
  const before = await readFile(join(baseDir, 'manifest.json'), 'utf8')
  const projectId = await freshProject()
  await sfx.execute({ projectId, items: [{ sound: '门-木门-敲门-三下-中等' }] }, exec)
  const after = await readFile(join(baseDir, 'manifest.json'), 'utf8')
  assert(before === after, 'placing a sound must not rewrite the pack manifest')
})

// ---------------------------------------------------------------------------

await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) await rm(anyaudioDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
