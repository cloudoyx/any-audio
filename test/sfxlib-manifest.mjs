// M4 acceptance: the pack the build script produces.
//
// Runs the real script on a small fixture, then checks the product the way the
// library will read it: every file exists, every duration matches the audio, no
// name repeats, and the fields each type needs are there.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { findFfmpeg, runFfmpeg } from '../src/tools/shared.js'
import { listPacks } from '../src/audio/sfx-library.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-sfxlib-manifest')
await rm(tmpDir, { recursive: true, force: true })
await mkdir(tmpDir, { recursive: true })

const ffmpeg = findFfmpeg()
if (!ffmpeg) {
  console.log('SKIP: ffmpeg is not available, so no pack can be built')
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

function runScript(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'build-sfx-pack.mjs'), ...args], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

async function makeMp3(path, seconds, frequency) {
  await mkdir(dirname(path), { recursive: true })
  await runFfmpeg(ffmpeg.command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-ac', '2', '-ar', '48000', '-b:a', '128k', '-c:a', 'libmp3lame',
    path,
  ])
}

// A source folder shaped like a real one: three types, a short sound, a long
// one, and a name without a dash.
const src = join(tmpDir, 'src')
await makeMp3(join(src, 'FOL', '门-木门-敲门-三下-中等.mp3'), 2, 440)
await makeMp3(join(src, 'FOL', '打铁.mp3'), 0.3, 500)
await makeMp3(join(src, 'AMB', '室外-森林-夜晚-虫鸣-中等.mp3'), 3, 220)
await makeMp3(join(src, 'DSN', '转场-Whoosh-短而急.mp3'), 1, 880)

const out = join(tmpDir, 'out')
const built = await runScript(['--src', src, '--out', out, '--id', 'Fixture', '--name', '测试包', '--license', 'CC0-1.0'])

// ---------------------------------------------------------------------------

await test('the script packs every entry and exits clean', async () => {
  assert(built.code === 0, `exit code ${built.code}: ${built.stderr}`)
  assert(existsSync(join(out, 'Fixture', 'manifest.json')), 'the manifest should exist')
})

await test('the manifest has the fields the library reads', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'Fixture', 'manifest.json'), 'utf8'))
  assert(manifest.schemaVersion === 1, `schemaVersion was ${manifest.schemaVersion}`)
  assert(manifest.id === 'Fixture', `id was ${manifest.id}`)
  assert(manifest.name === '测试包', `name was ${manifest.name}`)
  assert(manifest.license === 'CC0-1.0', `license was ${manifest.license}`)
  assert(manifest.format === 'mp3', `format was ${manifest.format}`)
  assert(manifest.sounds.length === 4, `expected 4 sounds, got ${manifest.sounds.length}`)
})

await test('every file the manifest names exists', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'Fixture', 'manifest.json'), 'utf8'))
  for (const sound of manifest.sounds) {
    const path = join(out, 'Fixture', sound.file)
    assert(existsSync(path), `missing file ${sound.file}`)
    const info = await stat(path)
    assert(info.size > 0, `${sound.file} is empty`)
  }
})

await test('the duration matches the audio within 0.1s', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'Fixture', 'manifest.json'), 'utf8'))
  const expected = {
    '门-木门-敲门-三下-中等': 2,
    '打铁': 0.3,
    '室外-森林-夜晚-虫鸣-中等': 3,
    '转场-Whoosh-短而急': 1,
  }
  for (const sound of manifest.sounds) {
    const want = expected[sound.name]
    assert(want !== undefined, `unexpected sound ${sound.name}`)
    assert(Math.abs(sound.durationSec - want) < 0.1, `${sound.name}: ${sound.durationSec}s, expected about ${want}s`)
  }
})

await test('foley and dsn carry a peak position, ambience does not', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'Fixture', 'manifest.json'), 'utf8'))
  for (const sound of manifest.sounds) {
    if (sound.type === 'ambience') {
      assert(sound.peakPosSec === undefined, `${sound.name} should carry no peakPosSec`)
    } else {
      assert(typeof sound.peakPosSec === 'number', `${sound.name} should carry a peakPosSec`)
      assert(sound.peakPosSec >= 0 && sound.peakPosSec <= sound.durationSec, `${sound.name}: peakPosSec ${sound.peakPosSec} is outside the sound`)
    }
  }
})

await test('the three types are sorted together', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'Fixture', 'manifest.json'), 'utf8'))
  const order = manifest.sounds.map((sound) => sound.type)
  const sorted = [...order].sort((a, b) => ['foley', 'ambience', 'dsn'].indexOf(a) - ['foley', 'ambience', 'dsn'].indexOf(b))
  assert(order.join(',') === sorted.join(','), `types were ${order.join(',')}`)
})

await test('the library can read the pack the script wrote', async () => {
  const { packs, warnings } = await listPacks({ root: out })
  assert(packs.length === 1, `expected 1 pack, got ${packs.length}`)
  assert(packs[0].id === 'Fixture', `id was ${packs[0].id}`)
  assert(packs[0].sounds.length === 4, `expected 4 sounds, got ${packs[0].sounds.length}`)
  assert(warnings.length === 0, `warnings: ${warnings.join(' | ')}`)
})

await test('a name without a dash is a warning, not a failure', async () => {
  const report = await readFile(join(out, 'build-report.txt'), 'utf8')
  assert(/打铁/.test(report) && /no "-" segment/.test(report), 'the report should warn about the name')
  assert(built.code === 0, 'the build should still succeed')
})

await test('a duplicate name stops the build', async () => {
  const dupSrc = join(tmpDir, 'dup')
  await makeMp3(join(dupSrc, 'FOL', '同名.mp3'), 1, 440)
  await makeMp3(join(dupSrc, 'AMB', '同名.mp3'), 1, 220)
  const result = await runScript(['--src', dupSrc, '--out', join(tmpDir, 'dup-out'), '--id', 'Dup'])
  assert(result.code !== 0, 'a duplicate name should fail the build')
  assert(/duplicate/i.test(result.stderr), `stderr was ${result.stderr}`)
})

await test('a name with a slash stops the build', async () => {
  const badSrc = join(tmpDir, 'bad')
  await makeMp3(join(badSrc, 'FOL', 'a-b.mp3'), 1, 440)
  const listPath = join(tmpDir, 'bad-list.json')
  await writeFile(listPath, JSON.stringify([
    { name: 'a/b', type: 'foley', source: join(badSrc, 'FOL', 'a-b.mp3') },
  ]), 'utf8')
  const result = await runScript(['--src', listPath, '--out', join(tmpDir, 'bad-out'), '--id', 'Bad'])
  assert(result.code !== 0, 'a slash in a name should fail the build')
  assert(/must not contain/i.test(result.stderr), `stderr was ${result.stderr}`)
})

await test('a missing source file stops the build', async () => {
  const listPath = join(tmpDir, 'missing-list.json')
  await writeFile(listPath, JSON.stringify([
    { name: 'a-b', type: 'foley', source: join(tmpDir, 'nope.mp3') },
  ]), 'utf8')
  const result = await runScript(['--src', listPath, '--out', join(tmpDir, 'missing-out'), '--id', 'Missing'])
  assert(result.code !== 0, 'a missing source should fail the build')
  assert(/not found/i.test(result.stderr), `stderr was ${result.stderr}`)
})

await test('an unknown type stops the build', async () => {
  const listPath = join(tmpDir, 'type-list.json')
  await writeFile(listPath, JSON.stringify([
    { name: 'a-b', type: 'music', source: join(src, 'FOL', '打铁.mp3') },
  ]), 'utf8')
  const result = await runScript(['--src', listPath, '--out', join(tmpDir, 'type-out'), '--id', 'Type'])
  assert(result.code !== 0, 'an unknown type should fail the build')
  assert(/unknown type/i.test(result.stderr), `stderr was ${result.stderr}`)
})

await test('a list-mode pack with no license leaves the field empty', async () => {
  const listPath = join(tmpDir, 'nolicense-list.json')
  await writeFile(listPath, JSON.stringify([
    { name: 'a-b', type: 'foley', source: join(src, 'FOL', '打铁.mp3') },
  ]), 'utf8')
  const result = await runScript(['--src', listPath, '--out', join(tmpDir, 'nolicense-out'), '--id', 'NoLicense'])
  assert(result.code === 0, `exit code ${result.code}: ${result.stderr}`)
  const manifest = JSON.parse(await readFile(join(tmpDir, 'nolicense-out', 'NoLicense', 'manifest.json'), 'utf8'))
  assert(manifest.license === '', `license was "${manifest.license}"`)
})

await test('a pack with only FOL/ builds and holds only foley', async () => {
  const onlySrc = join(tmpDir, 'only')
  await makeMp3(join(onlySrc, 'FOL', '打铁.mp3'), 1, 440)
  await makeMp3(join(onlySrc, 'FOL', '断骨.mp3'), 1, 460)
  const result = await runScript(['--src', onlySrc, '--out', join(tmpDir, 'only-out'), '--id', 'OnlyFoley'])
  assert(result.code === 0, `exit code ${result.code}: ${result.stderr}`)
  const manifest = JSON.parse(await readFile(join(tmpDir, 'only-out', 'OnlyFoley', 'manifest.json'), 'utf8'))
  assert(manifest.sounds.length === 2, `expected 2 sounds, got ${manifest.sounds.length}`)
  assert(manifest.sounds.every((sound) => sound.type === 'foley'), 'every sound should be foley')
  assert(!existsSync(join(tmpDir, 'only-out', 'OnlyFoley', 'AMB')), 'no empty AMB directory should be created')
})

await test('building the same input twice gives the same manifest', async () => {
  const first = await readFile(join(out, 'Fixture', 'manifest.json'), 'utf8')
  await runScript(['--src', src, '--out', join(tmpDir, 'out2'), '--id', 'Fixture', '--name', '测试包', '--license', 'CC0-1.0'])
  const second = await readFile(join(tmpDir, 'out2', 'Fixture', 'manifest.json'), 'utf8')
  assert(first === second, 'the same input should produce the same manifest')
})

// ---------------------------------------------------------------------------

await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) await rm(anyaudioDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
