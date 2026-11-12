// M2 acceptance: finding a name in the installed packs.
//
// The rule under test is one line — a name that contains the query is a hit,
// wherever the query sits — plus the ordering that decides who comes first
// without ever dropping a hit.
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPacks, search } from '../src/audio/sfx-library.js'
import { sfxToolDefinition } from '../src/tools/sfx.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-sfxlib-search')
await rm(tmpDir, { recursive: true, force: true })
await mkdir(tmpDir, { recursive: true })

const libraryRoot = join(tmpDir, 'sfx')
process.env.ANYAUDIO_SFX_DIR = libraryRoot

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

async function writePack(packId, sounds) {
  const dir = join(libraryRoot, packId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: packId,
    name: packId,
    sounds,
  }, null, 2)}\n`, 'utf8')
}

function sound(name, type = 'foley', durationSec = 2) {
  return { name, type, durationSec, peakPosSec: 0.5, file: `FOL/${name}.mp3` }
}

// A priority pack with the names the plan's examples use, and a normal pack
// with a few more so "search every pack" is actually exercised.
await writePack('BaseSFX', [
  sound('OUTBED-草地-草原风声偶尔有猫头鹰', 'ambience', 30),
  sound('门-木门-敲门-三下-中等'),
  sound('门-敲门-连续十下用力拍门'),
  sound('门-铁门-关门-重-混响大'),
  sound('脚步-木地板-高跟鞋-行走', 'foley', 12),
  sound('脚步-雪地-行走', 'foley', 36),
  sound('汽车-刹车-撞车-金属破碎声-中等剧烈'),
])
await writePack('UserSFX1', [
  sound('打铁'),
  sound('断骨'),
  sound('草地-雨后-虫鸣', 'ambience', 20),
])

const { packs } = await listPacks()

// ---------------------------------------------------------------------------

await test('the search description carries the three rules', async () => {
  const description = sfxToolDefinition.parameters.properties.query.description
  assert(/short words, not sentences/i.test(description), `the description should say to use short words: ${description}`)
  assert(/change the dimension/i.test(description), 'the description should say to change the dimension')
  assert(/3 rounds/i.test(description), 'the description should say to stop after 3 rounds')
})

await test('a word in the middle of a name is a hit', async () => {
  const result = search(packs, { query: '草地' })
  assert(result.total === 2, `expected 2 hits for 草地, got ${result.total}`)
  assert(result.results.some((entry) => entry.name === 'OUTBED-草地-草原风声偶尔有猫头鹰'), 'the ambience name should be found')
  assert(result.results.some((entry) => entry.name === '草地-雨后-虫鸣'), 'the normal-pack name should be found too')
})

await test('a word at the end of a name is a hit', async () => {
  const result = search(packs, { query: '猫头鹰' })
  assert(result.total === 1, `expected 1 hit for 猫头鹰, got ${result.total}`)
  assert(result.results[0].name === 'OUTBED-草地-草原风声偶尔有猫头鹰', `name was ${result.results[0].name}`)
})

await test('a phrase whose characters are out of order finds nothing', async () => {
  const phrase = search(packs, { query: '用力敲门' })
  assert(phrase.total === 0, `expected 0 hits for 用力敲门, got ${phrase.total}`)
  const word = search(packs, { query: '敲门' })
  assert(word.total === 2, `expected 2 hits for 敲门, got ${word.total}`)
})

await test('a priority-pack name is searchable too', async () => {
  const result = search(packs, { query: '敲门' })
  assert(result.results.every((entry) => entry.packId === 'BaseSFX'), 'both hits are in the priority pack')
  assert(result.results.every((entry) => entry.priority === true), 'a priority-pack hit should be marked')
})

await test('a normal-pack name is searchable and not marked priority', async () => {
  const result = search(packs, { query: '打铁' })
  assert(result.total === 1, `expected 1 hit, got ${result.total}`)
  assert(result.results[0].packId === 'UserSFX1', `packId was ${result.results[0].packId}`)
  assert(result.results[0].priority === false, 'a normal-pack hit should not be marked priority')
})

await test('an exact name ranks above a longer one that contains it', async () => {
  const result = search(packs, { query: '脚步-雪地-行走' })
  assert(result.results[0].name === '脚步-雪地-行走', `first hit was ${result.results[0].name}`)
})

await test('a whole segment ranks above a partial one', async () => {
  const result = search(packs, { query: '脚步' })
  assert(result.total === 2, `expected 2 hits, got ${result.total}`)
  // Both start with 脚步, so the tie is broken by position then duration.
  assert(result.results.every((entry) => entry.name.startsWith('脚步')), 'both hits start with 脚步')
})

await test('the limit truncates the list but reports the real total', async () => {
  const result = search(packs, { query: '门', limit: 2 })
  assert(result.total >= 3, `expected at least 3 hits for 门, got ${result.total}`)
  assert(result.shown === 2, `shown was ${result.shown}`)
  assert(result.truncated === true, 'a truncated result should say so')
  assert(result.results.length === 2, `results length was ${result.results.length}`)
})

await test('the default limit is 30', async () => {
  const result = search(packs, { query: '门' })
  assert(result.shown === result.total, 'with few hits nothing should be truncated')
})

await test('a type filter narrows the hits', async () => {
  const all = search(packs, { query: '草地' })
  const ambience = search(packs, { query: '草地', type: 'ambience' })
  assert(all.total === 2, `expected 2 unfiltered hits, got ${all.total}`)
  assert(ambience.total === 2, `expected 2 ambience hits, got ${ambience.total}`)
  const foley = search(packs, { query: '草地', type: 'foley' })
  assert(foley.total === 0, `expected 0 foley hits, got ${foley.total}`)
})

await test('an unknown type is refused instead of silently ignored', async () => {
  let error = null
  try {
    search(packs, { query: '草地', type: 'music' })
  } catch (caught) {
    error = caught
  }
  assert(error, 'an unknown type should be refused')
  assert(/unknown sound type/.test(error.message), `message was ${error.message}`)
})

await test('an empty query is refused', async () => {
  let error = null
  try {
    search(packs, { query: '   ' })
  } catch (caught) {
    error = caught
  }
  assert(error, 'an empty query should be refused')
})

await test('no hits returns an empty list, not an error', async () => {
  const result = search(packs, { query: '完全不存在的东西' })
  assert(result.total === 0, `total was ${result.total}`)
  assert(result.results.length === 0, `results length was ${result.results.length}`)
  assert(result.truncated === false, 'an empty result is not truncated')
})

await test('every hit carries the pack it came from', async () => {
  const result = search(packs, { query: '行走' })
  assert(result.total === 2, `expected 2 hits, got ${result.total}`)
  for (const entry of result.results) {
    assert(typeof entry.packId === 'string' && entry.packId, 'each hit should name its pack')
    assert(typeof entry.durationSec === 'number', 'each hit should carry its duration')
    assert(['foley', 'ambience', 'dsn'].includes(entry.type), `unexpected type ${entry.type}`)
  }
})

// ---------------------------------------------------------------------------

await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) await rm(anyaudioDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
