// M0 acceptance: pack discovery, manifest validation and name resolution.
// Everything runs inside .anyaudio/test-tmp with ANYAUDIO_SFX_DIR pointed at a
// scratch library, so the user's real ~/.dsh/anyaudio/sfx is never read or
// written.
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPacks, nearestNames, resolveSound, userSfxDir } from '../src/audio/sfx-library.js'
import { normalizeManifest, SFX_SOUND_TYPES } from '../src/audio/sfx-manifest.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-sfxlib')
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

/** Write one pack directory. `sounds` is the raw manifest array. */
async function writePack(packId, sounds, extra = {}) {
  const dir = join(libraryRoot, packId)
  await mkdir(dir, { recursive: true })
  const manifest = {
    schemaVersion: 1,
    id: packId,
    name: extra.name ?? packId,
    version: '1.0.0',
    license: extra.license ?? 'CC0-1.0',
    format: 'mp3',
    sounds,
  }
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return dir
}

function sound(name, type = 'foley', extra = {}) {
  return { name, type, durationSec: 1.5, peakPosSec: 0.4, file: `FOL/${name}.mp3`, ...extra }
}

// ---------------------------------------------------------------------------

await test('an empty library returns an empty list without throwing', async () => {
  await mkdir(libraryRoot, { recursive: true })
  const { packs, warnings } = await listPacks()
  assert(packs.length === 0, `expected no packs, got ${packs.length}`)
  assert(warnings.length === 0, `expected no warnings, got ${warnings.join(' | ')}`)
})

await test('a missing library directory is not an error', async () => {
  const { packs } = await listPacks({ root: join(tmpDir, 'does-not-exist') })
  assert(packs.length === 0, 'a missing root should read as an empty library')
})

await test('one valid pack exposes its entries with the right fields', async () => {
  await writePack('BaseSFX', [
    sound('门-木门-敲门-三下-中等'),
    sound('室外-森林-夜晚-虫鸣-中等', 'ambience', { peakPosSec: undefined, file: 'AMB/室外-森林-夜晚-虫鸣-中等.mp3' }),
    sound('转场-Whoosh-短而急', 'dsn', { durationSec: 0.8, peakPosSec: 0.2, file: 'DSN/转场-Whoosh-短而急.mp3' }),
  ])
  const { packs, warnings } = await listPacks()
  assert(packs.length === 1, `expected 1 pack, got ${packs.length}`)
  const pack = packs[0]
  assert(pack.id === 'BaseSFX', `id was ${pack.id}`)
  assert(pack.name === 'BaseSFX', `name was ${pack.name}`)
  assert(pack.sounds.length === 3, `expected 3 sounds, got ${pack.sounds.length}`)
  const knock = pack.sounds.find((entry) => entry.name === '门-木门-敲门-三下-中等')
  assert(knock.type === 'foley', `type was ${knock.type}`)
  assert(knock.durationSec === 1.5, `durationSec was ${knock.durationSec}`)
  assert(knock.peakPosSec === 0.4, `peakPosSec was ${knock.peakPosSec}`)
  assert(knock.file === 'FOL/门-木门-敲门-三下-中等.mp3', `file was ${knock.file}`)
  assert(knock.packId === 'BaseSFX', `packId was ${knock.packId}`)
  const ambience = pack.sounds.find((entry) => entry.type === 'ambience')
  assert(ambience.peakPosSec === undefined, 'ambience should carry no peakPosSec')
  assert(warnings.length === 0, `expected no warnings, got ${warnings.join(' | ')}`)
})

await test('a broken manifest is skipped with a warning and the others still load', async () => {
  const dir = join(libraryRoot, 'Broken')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), '{ this is not json', 'utf8')
  const { packs, warnings } = await listPacks()
  assert(packs.some((pack) => pack.id === 'BaseSFX'), 'the good pack should still load')
  assert(!packs.some((pack) => pack.id === 'Broken'), 'the broken pack should be skipped')
  assert(warnings.some((line) => /Broken/.test(line) && /JSON/i.test(line)), `warnings were ${warnings.join(' | ')}`)
})

await test('a directory without a manifest is skipped with a warning', async () => {
  await mkdir(join(libraryRoot, 'NoManifest'), { recursive: true })
  const { packs, warnings } = await listPacks()
  assert(!packs.some((pack) => pack.id === 'NoManifest'), 'a manifest-less directory should be skipped')
  assert(warnings.some((line) => /NoManifest/.test(line) && /manifest/i.test(line)), `warnings were ${warnings.join(' | ')}`)
})

await test('a duplicate name inside one pack is an error', async () => {
  await writePack('Dup', [sound('同一个名字'), sound('同一个名字')])
  const { packs, warnings } = await listPacks()
  assert(!packs.some((pack) => pack.id === 'Dup'), 'the pack with a duplicate should be skipped')
  assert(warnings.some((line) => /Dup/.test(line) && /duplicate/.test(line)), `warnings were ${warnings.join(' | ')}`)
})

await test('an unknown type drops that entry and keeps the rest', async () => {
  await writePack('Mixed', [sound('好的'), sound('坏的', 'music')])
  const { packs, warnings } = await listPacks()
  const pack = packs.find((entry) => entry.id === 'Mixed')
  assert(pack, 'the pack should still load')
  assert(pack.sounds.length === 1, `expected 1 surviving sound, got ${pack.sounds.length}`)
  assert(pack.sounds[0].name === '好的', `survivor was ${pack.sounds[0].name}`)
  assert(warnings.some((line) => /Mixed/.test(line) && /unknown type/.test(line)), `warnings were ${warnings.join(' | ')}`)
})

await test('ANYAUDIO_SFX_DIR redirects the library and the real one is untouched', async () => {
  assert(userSfxDir() === libraryRoot, `userSfxDir() was ${userSfxDir()}`)
  const real = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'anyaudio', 'sfx')
  assert(userSfxDir() !== real, 'the test library must not be the real one')
})

await test('a bare name unique across the machine resolves', async () => {
  const { packs } = await listPacks()
  const { sound: found, pack } = resolveSound(packs, '门-木门-敲门-三下-中等')
  assert(found.name === '门-木门-敲门-三下-中等', `resolved ${found.name}`)
  assert(pack.id === 'BaseSFX', `pack was ${pack.id}`)
})

await test('a bare name in two packs is a conflict that lists every candidate', async () => {
  await writePack('Other', [sound('门-木门-敲门-三下-中等')])
  const { packs } = await listPacks()
  const error = await rejects(
    () => resolveSound(packs, '门-木门-敲门-三下-中等'),
    /more than one pack/,
    'a duplicated bare name must not resolve silently',
  )
  assert(/BaseSFX\//.test(error.message) && /Other\//.test(error.message), `candidates were missing: ${error.message}`)
})

await test('pack/name addresses one sound exactly', async () => {
  const { packs } = await listPacks()
  const { sound: found, pack } = resolveSound(packs, 'Other/门-木门-敲门-三下-中等')
  assert(pack.id === 'Other', `pack was ${pack.id}`)
  assert(found.packId === 'Other', `sound packId was ${found.packId}`)
})

await test('a missing pack and a missing sound give different messages', async () => {
  const { packs } = await listPacks()
  const noPack = await rejects(() => resolveSound(packs, 'Nope/门-木门-敲门-三下-中等'), /no sound pack "Nope"/, 'missing pack')
  assert(/Installed packs:/.test(noPack.message), `the installed list was missing: ${noPack.message}`)
  assert(/BaseSFX/.test(noPack.message), `the installed list should name BaseSFX: ${noPack.message}`)
  const noSound = await rejects(() => resolveSound(packs, 'BaseSFX/不存在的名字'), /has no sound named/, 'missing sound')
  assert(!/no sound pack/.test(noSound.message), 'a missing sound must not be reported as a missing pack')
})

await test('a name with "/" or surrounding whitespace is refused at manifest time', async () => {
  await rejects(
    () => normalizeManifest({ id: 'X', sounds: [sound('a/b')] }, { packId: 'X' }),
    /must not contain "\/"/,
    'a slash in a name',
  )
  await rejects(
    () => normalizeManifest({ id: 'X', sounds: [sound(' 前后有空格 ')] }, { packId: 'X' }),
    /whitespace/,
    'surrounding whitespace',
  )
})

await test('full-width punctuation, spaces and "_" are legal names', async () => {
  const names = ['人，拍手 鼓掌', 'D点烟（普通火机）', '脚步 木材，毯子女人脚后跟 散步', 'a_b-c']
  await writePack('Messy', names.map((name) => sound(name)))
  const { packs, warnings } = await listPacks()
  const pack = packs.find((entry) => entry.id === 'Messy')
  assert(pack, `the pack should load; warnings: ${warnings.join(' | ')}`)
  assert(pack.sounds.length === names.length, `expected ${names.length} sounds, got ${pack.sounds.length}`)
  for (const name of names) {
    const { sound: found } = resolveSound(packs, `Messy/${name}`)
    assert(found.name === name, `resolved ${found.name} instead of ${name}`)
  }
})

await test('a pack with only FOL/ loads', async () => {
  await writePack('OnlyFoley', [sound('打铁'), sound('断骨')])
  const { packs } = await listPacks()
  const pack = packs.find((entry) => entry.id === 'OnlyFoley')
  assert(pack, 'a single-subdirectory pack should load')
  assert(pack.sounds.every((entry) => entry.type === 'foley'), 'every entry should be foley')
})

await test('an old name after a rename reports the closest candidates', async () => {
  await writePack('Renamed', [sound('门-木门-敲门-三下-中等-新版')])
  const { packs } = await listPacks()
  const error = await rejects(
    () => resolveSound(packs, 'Renamed/门-木门-敲门-三下-中等'),
    /has no sound named/,
    'an old name must fail with candidates',
  )
  assert(/closest:/.test(error.message), `no candidates offered: ${error.message}`)
  assert(/新版/.test(error.message), `the closest candidate should be the renamed one: ${error.message}`)
})

await test('nearestNames ranks a near miss above an unrelated name', async () => {
  const ranked = nearestNames('门-木门-敲门', ['门-木门-敲门-三下', '汽车-刹车-撞车', '脚步-木地板-行走'])
  assert(ranked[0] === '门-木门-敲门-三下', `ranked ${ranked.join(', ')}`)
})

await test('a manifest with a newer schemaVersion still loads, with a warning', async () => {
  const dir = join(libraryRoot, 'Future')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 99,
    id: 'Future',
    sounds: [sound('未来的音效')],
    somethingNew: true,
  }), 'utf8')
  const { packs, warnings } = await listPacks()
  assert(packs.some((pack) => pack.id === 'Future'), 'a newer schema should still load')
  assert(warnings.some((line) => /Future/.test(line) && /newer/.test(line)), `warnings were ${warnings.join(' | ')}`)
})

await test('the three sound types are exactly foley, ambience and dsn', async () => {
  assert(SFX_SOUND_TYPES.join(',') === 'foley,ambience,dsn', `types were ${SFX_SOUND_TYPES.join(',')}`)
})

// ---------------------------------------------------------------------------

await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) await rm(anyaudioDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
