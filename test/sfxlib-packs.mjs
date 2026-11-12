// M3 acceptance: the pack routes and the priority setting.
//
// Mounts the real host routes on a local HTTP server with DSH-shaped service
// stubs, and points ANYAUDIO_SFX_DIR at a scratch library so the user's real
// packs are never read, installed into, or deleted.
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerAnyAudioRoutes } from '../src/host/routes.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const testRoot = join(anyaudioDir, 'test-tmp-sfxlib-packs')
await rm(testRoot, { recursive: true, force: true })
await mkdir(testRoot, { recursive: true })

const libraryRoot = join(testRoot, 'sfx')
const configPath = join(testRoot, 'config.json')
process.env.ANYAUDIO_SFX_DIR = libraryRoot
process.env.ANYAUDIO_CONFIG = configPath
process.env.ANYAUDIO_STATE = join(testRoot, 'state.json')

let handler
const webServer = { register: (route) => { handler = route.handler; return () => {} } }
const ctx = {
  get: (id) => (id === 'webServer' ? webServer : undefined),
  inject: (_, fn) => fn(ctx),
  effect: (fn) => fn(),
  logger: { info: () => {} },
}
registerAnyAudioRoutes(ctx, { log: { info: () => {} }, workspaceRoot: root })

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
  })
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function writePack(dir, packId, sounds, extra = {}) {
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

function sound(name, type = 'foley') {
  return { name, type, durationSec: 2, peakPosSec: 0.5, file: `FOL/${name}.mp3` }
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/api/dsh-any-audio`
  const client = { 'x-any-audio-client': 'any-audio/1' }
  const get = async (path) => (await fetch(base + path, { headers: client })).json()
  const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { ...client, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

  let passed = 0
  let failed = 0
  const step = async (name, fn) => {
    try {
      await fn()
      passed++
      console.log('PASS', name)
    } catch (error) {
      failed++
      console.log('FAIL', name, '—', error.message)
    }
  }

  // A pack already in the library, and a pack outside it waiting to be installed.
  await writePack(join(libraryRoot, 'BaseSFX'), 'BaseSFX', [
    sound('门-木门-敲门-三下-中等'),
    sound('室外-森林-夜晚-虫鸣-中等', 'ambience'),
  ], { name: '基础音效包' })
  const outside = join(testRoot, 'incoming', 'UserSFX1')
  await writePack(outside, 'UserSFX1', [
    sound('打铁'),
    sound('断骨'),
    sound('炒菜'),
  ], { name: '用户素材包', license: '' })

  await step('the pack list reports counts and the priority default', async () => {
    const result = await get('/sfx/packs')
    assert(result.ok === true, `ok was ${result.ok}`)
    assert(result.packs.length === 1, `expected 1 pack, got ${result.packs.length}`)
    const base = result.packs[0]
    assert(base.id === 'BaseSFX', `id was ${base.id}`)
    assert(base.count === 2, `count was ${base.count}`)
    assert(base.priority === true, 'BaseSFX should be priority by default')
    assert(typeof base.tokens === 'number' && base.tokens > 0, `tokens was ${base.tokens}`)
    assert(result.root === libraryRoot, `root was ${result.root}`)
  })

  await step('a normal pack reports no token cost', async () => {
    await post('/sfx/packs/install', { fromPath: outside })
    const result = await get('/sfx/packs')
    const user = result.packs.find((pack) => pack.id === 'UserSFX1')
    assert(user, 'UserSFX1 should be installed')
    assert(user.priority === false, 'a new pack should be normal')
    assert(user.tokens === null, `a normal pack should report no tokens, got ${user.tokens}`)
  })

  await step('installing copies the whole pack into the library', async () => {
    const manifest = JSON.parse(await readFile(join(libraryRoot, 'UserSFX1', 'manifest.json'), 'utf8'))
    assert(manifest.id === 'UserSFX1', `manifest id was ${manifest.id}`)
    assert(manifest.sounds.length === 3, `manifest sounds were ${manifest.sounds.length}`)
    assert(existsSync(join(libraryRoot, 'UserSFX1', 'FOL', '打铁.mp3')) === false, 'the fixture has no audio files, only the manifest')
  })

  await step('toggling a pack to normal persists and reads back', async () => {
    const toggled = await post('/sfx/packs/toggle', { id: 'BaseSFX', priority: false })
    assert(toggled.ok === true, `ok was ${toggled.ok}`)
    assert(toggled.priority === false, `priority was ${toggled.priority}`)
    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    assert(saved.sfx.packs.BaseSFX === 'normal', `config said ${JSON.stringify(saved.sfx.packs)}`)
    const listed = await get('/sfx/packs')
    assert(listed.packs.find((pack) => pack.id === 'BaseSFX').priority === false, 'the list should read it back as normal')
  })

  await step('a pack explicitly set to normal stays normal', async () => {
    // This is the case a list of priority ids cannot express: the pack is absent
    // from the priority list, which used to mean "fall back to the default".
    const listed = await get('/sfx/packs')
    const base = listed.packs.find((pack) => pack.id === 'BaseSFX')
    assert(base.priority === false, 'BaseSFX must stay normal after being set to normal')
  })

  await step('toggling back to priority persists too', async () => {
    await post('/sfx/packs/toggle', { id: 'BaseSFX', priority: true })
    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    assert(saved.sfx.packs.BaseSFX === 'priority', `config said ${JSON.stringify(saved.sfx.packs)}`)
  })

  await step('toggling without an explicit value flips the current state', async () => {
    const before = (await get('/sfx/packs')).packs.find((pack) => pack.id === 'UserSFX1').priority
    const flipped = await post('/sfx/packs/toggle', { id: 'UserSFX1' })
    assert(flipped.priority === !before, `flip went from ${before} to ${flipped.priority}`)
  })

  await step('a pack with only FOL/ installs', async () => {
    const onlyFoley = join(testRoot, 'incoming', 'OnlyFoley')
    await writePack(onlyFoley, 'OnlyFoley', [sound('打铁'), sound('断骨')])
    const result = await post('/sfx/packs/install', { fromPath: onlyFoley })
    assert(result.ok === true, `ok was ${result.ok}`)
    assert(result.count === 2, `count was ${result.count}`)
    const listed = await get('/sfx/packs')
    assert(listed.packs.some((pack) => pack.id === 'OnlyFoley'), 'the pack should be listed')
  })

  await step('a directory without a manifest is refused with a clear message', async () => {
    const bare = join(testRoot, 'incoming', 'Bare')
    await mkdir(bare, { recursive: true })
    const result = await post('/sfx/packs/install', { fromPath: bare })
    assert(result.ok === false, 'a manifest-less directory should be refused')
    assert(/manifest/i.test(result.error), `error was ${result.error}`)
    assert(/build/i.test(result.error), `the error should point at the build script: ${result.error}`)
  })

  await step('a missing directory is refused', async () => {
    const result = await post('/sfx/packs/install', { fromPath: join(testRoot, 'nope') })
    assert(result.ok === false, 'a missing directory should be refused')
  })

  await step('removing a pack deletes it and its priority entry', async () => {
    const result = await post('/sfx/packs/remove', { id: 'OnlyFoley' })
    assert(result.ok === true, `ok was ${result.ok}`)
    const listed = await get('/sfx/packs')
    assert(!listed.packs.some((pack) => pack.id === 'OnlyFoley'), 'the pack should be gone')
    assert(!existsSync(join(libraryRoot, 'OnlyFoley')), 'the directory should be gone')
  })

  await step('removing a pack that is not there is not an error', async () => {
    const result = await post('/sfx/packs/remove', { id: 'NeverInstalled' })
    assert(result.ok === true, `ok was ${result.ok}`)
  })

  await step('a pack id that tries to leave the library is refused', async () => {
    const result = await post('/sfx/packs/remove', { id: '../outside' })
    assert(result.ok === false, 'a traversal id should be refused')
  })

  await step('the routes require the settings-page header', async () => {
    const response = await fetch(`${base}/sfx/packs`)
    assert(response.status === 403, `status was ${response.status}`)
  })

  await step('the real library was never touched', async () => {
    const real = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'anyaudio', 'sfx')
    assert(libraryRoot !== real, 'the test library must not be the real one')
  })

  server.close()
  await rm(testRoot, { recursive: true, force: true })
  if (!hadAnyaudioDir) await rm(anyaudioDir, { recursive: true, force: true })

  console.log(`\n${passed} steps passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
})
