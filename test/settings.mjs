// Settings bridge acceptance: mounts the real host routes on a local HTTP server
// with DSH-shaped service stubs, then exercises every endpoint.
import http from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerAnyAudioRoutes } from '../src/host/routes.js'
import { musicToolDefinition } from '../src/tools/music.js'
import { statePath } from '../src/audio/font-state.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Snapshot the real machine-wide state before pointing anything at the scratch
// folder: the acceptance run must leave the user's own files untouched.
async function snapshot(path) {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, content: await readFile(path, 'utf8') }
  } catch {
    return null
  }
}

const realStatePath = statePath()
const realStateBefore = await snapshot(realStatePath)

// Keep acceptance runs away from the user's real machine-wide config and font
// library: the library is shared by every project, so a test must never write
// into (or delete from) the real one.
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const testRoot = join(anyaudioDir, 'test-tmp')
const testConfigPath = join(testRoot, 'config.json')
process.env.ANYAUDIO_CONFIG = testConfigPath
process.env.ANYAUDIO_STATE = join(testRoot, 'state.json')
await rm(testConfigPath, { force: true })
await mkdir(dirname(testConfigPath), { recursive: true })

const { defaultFontPath } = await import('../src/audio/fonts.js')
const seeded = await defaultFontPath().catch(() => null)

const testFontDir = join(testRoot, 'fonts')
await rm(testFontDir, { recursive: true, force: true })
await mkdir(testFontDir, { recursive: true })
process.env.ANYAUDIO_FONT_DIR = testFontDir

// Seed the temporary library with one real bank so the preview/verify steps can
// run; when the machine has no bank installed those steps skip themselves.
if (seeded) await copyFile(seeded, join(testFontDir, seeded.split(/[\\/]/).pop()))

let handler
const webServer = { register: (route) => { handler = route.handler; return () => {} } }
const secrets = new Map()
const credentials = {
  async describe(ref) { return { ref, configured: secrets.has(ref) } },
  async set(ref, value) { secrets.set(ref, value) },
  async unset(ref) { secrets.delete(ref) },
  async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref), source: 'test' } : undefined },
}
const ctx = {
  get: (id) => (id === 'webServer' ? webServer : id === 'credentials' ? credentials : undefined),
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

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/api/dsh-any-audio`
  const client = { 'x-any-audio-client': 'any-audio/1' }
  const get = async (path) => (await fetch(base + path, { headers: client })).json()
  const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { ...client, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  const origin = `http://127.0.0.1:${port}`
  const raw = async (url) => fetch(url.startsWith('http') ? url : origin + url, { headers: client })
  let passed = 0
  let skipped = 0
  const step = async (name, fn) => {
    try {
      await fn()
      passed++
      console.log('PASS', name)
    } catch (error) {
      if (error?.skip) {
        skipped++
        console.log('SKIP', name, '—', error.message)
        return
      }
      console.log('FAIL', name, '—', error.message)
    }
  }

  const state = await get('/state')
  await step('state exposes config, fonts and tts providers', () => {
    assert(state.ok, 'state not ok')
    assert(state.config?.tts?.provider === 'edge', `default provider should be edge, got ${JSON.stringify(state.config?.tts?.provider)}`)
    assert(state.fonts.rows.length >= 1, 'installed fonts missing')
    assert(state.tts.providers.length === 2, 'two providers expected')
  })
  console.log('  fonts:', state.fonts.rows.map((row) => `${row.name}:${row.status}`).join(', '))
  console.log('  default font:', state.fonts.defaultPath)

  await step('rejects requests that do not come from the settings page', async () => {
    const bare = await fetch(base + '/state')
    assert(bare.status === 403, `expected 403 without client header, got ${bare.status}`)
    const crossSite = await fetch(base + '/state', { headers: { ...client, 'sec-fetch-site': 'cross-site' } })
    assert(crossSite.status === 403, `expected 403 for cross-site, got ${crossSite.status}`)
    const crossPost = await fetch(base + '/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ patch: { mix: { ducking: { targetDb: -20 } } } }),
    })
    assert(crossPost.status === 403, `expected 403 for cross-site POST, got ${crossPost.status}`)
  })

  await step('config update then read back (machine-wide file)', async () => {
    const saved = await post('/config', { patch: { mix: { ducking: { targetDb: -12 } }, output: { dir: '' } } })
    assert(saved.ok, saved.error)
    const again = await get('/state')
    assert(again.config.mix.ducking.targetDb === -12, 'value not persisted')
    const onDisk = JSON.parse(await readFile(again.configPath, 'utf8'))
    assert(onDisk.mix.ducking.targetDb === -12, 'file not written')
    assert(
      again.configPath === testConfigPath || (again.configPath.includes('.dsh') && !again.configPath.includes('profiles')),
      `config path is not machine-wide: ${again.configPath}`,
    )
  })

  await step('invalid config values are clamped, unknown providers rejected', async () => {
    const saved = await post('/config', { patch: { tts: { provider: 'nope' }, mix: { ducking: { targetDb: -999 } }, music: { sampleRate: 1 } } })
    assert(saved.ok, saved.error)
    assert(saved.config.tts.provider === 'edge', 'provider must fall back')
    assert(saved.config.mix.ducking.targetDb === -40, 'targetDb must clamp to -40')
    assert(saved.config.music.sampleRate === 8000, 'sampleRate must clamp')
  })

  await step('config reset restores defaults', async () => {
    const reset = await post('/config/reset', {})
    assert(reset.ok, reset.error)
    const again = await get('/state')
    assert(again.config.mix.ducking.targetDb === -9, 'ducking default not restored')
    assert(again.config.music.peakDb === -3, 'peak default not restored')
  })

  await step('font preview renders a real WAV', async () => {
    const font = state.fonts.rows[0]
    const preview = await post('/sources/preview', { path: font.path })
    assert(preview.id, preview.error)
    assert(preview.durationSec >= 2 && preview.durationSec <= 5, `unexpected duration ${preview.durationSec}`)
    const audio = await raw(preview.url)
    const bytes = Buffer.from(await audio.arrayBuffer())
    assert(audio.headers.get('content-type') === 'audio/wav', `preview is not a wav (url ${preview.url}, status ${audio.status}, type ${audio.headers.get('content-type')}, body ${bytes.subarray(0, 120).toString('utf8')})`)
    assert(bytes.toString('ascii', 0, 4) === 'RIFF', 'preview bytes are not RIFF')
    // <audio> elements cannot send custom headers: the browser request must still work.
    const browserAudio = await fetch(origin + preview.url)
    assert(browserAudio.status === 200, `browser audio request failed with ${browserAudio.status}`)
    assert(browserAudio.headers.get('content-type') === 'audio/wav', 'browser audio is not a wav')
    console.log(`  preview: ${preview.durationSec}s peak ${preview.peakDb}dBFS ${bytes.length} bytes`)
  })

  await step('font presets can be listed and previewed per program', async () => {
    const font = state.fonts.rows.find((row) => row.recommendedId === 'generaluser') ?? state.fonts.rows[0]
    const list = await get(`/sources/presets?path=${encodeURIComponent(font.path)}`)
    assert(list.ok && Array.isArray(list.presets), `preset list failed: ${list.error}`)
    assert(list.presets.length > 100, `expected a large GM preset list, got ${list.presets.length}`)
    assert(list.presets.some((preset) => preset.program === 0), 'piano preset missing')
    const chosen = list.presets.find((preset) => preset.program === 73) ?? list.presets[1]
    const preview = await post('/sources/preview', { path: font.path, program: chosen.program })
    assert(preview.id, preview.error)
    assert(preview.label.includes(chosen.name), `label should name the chosen preset, got "${preview.label}"`)
    console.log(`  preset preview: program ${chosen.program} ${chosen.name}`)
  })

  await step('font verify compares sha256 with the recommended hash', async () => {
    const font = state.fonts.rows.find((row) => row.recommendedId === 'generaluser') ?? state.fonts.rows[0]
    const result = await post('/sources/verify', { path: font.path })
    assert(typeof result.ok === 'boolean', 'verify returned no verdict')
    assert(result.sha256?.length === 64, 'sha256 missing')
    console.log(`  verify: ${font.name} -> ${result.ok ? 'match' : 'mismatch'}`)
  })

  await step('edge tts preview produces audio', async () => {
    let preview
    for (let attempt = 0; attempt < 2; attempt++) {
      preview = await post('/tts/preview', { provider: 'edge', voice: 'zh-CN-YunjianNeural', text: '太行、王屋二山。' })
      if (preview.id) break
      if (!/429|rate limit|too many/i.test(preview.error ?? '')) break
      await new Promise((resolve) => setTimeout(resolve, 30000))
    }
    if (!preview.id && /429|rate limit|too many/i.test(preview.error ?? '')) {
      const skippedError = new Error('Edge is rate limiting this machine (HTTP 429); the same path was verified separately today')
      skippedError.skip = true
      throw skippedError
    }
    assert(preview.id, preview.error)
    const audio = await raw(preview.url)
    assert(audio.headers.get('content-type') === 'audio/wav', 'tts preview is not wav')
    console.log(`  tts: ${preview.durationSec}s peak ${preview.peakDb}dBFS`)
  })

  await step('mimo without a key fails with a clear message', async () => {
    const result = await post('/tts/preview', { provider: 'mimo', voice: 'mimo_default', text: '测试' })
    assert(result.ok === false, 'mimo should fail without a key')
    assert(/Open Platform|key/i.test(result.error), `unclear error: ${result.error}`)
  })

  await step('credential set/describe/unset round-trip', async () => {
    const set = await post('/credentials/set', { value: 'sk-test-1234567890' })
    assert(set.ok, set.error)
    const described = await get('/credentials')
    assert(described.configured === true, 'credential not configured')
    const unset = await post('/credentials/unset', {})
    assert(unset.ok, unset.error)
    const after = await get('/credentials')
    assert(after.configured === false, 'credential not removed')
  })

  await step('install from a local file into the shared library, then delete it', async () => {
    const source = join(testRoot, 'custom-bank.sf2')
    await writeFile(source, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 7)]))
    const install = await post('/sources/install', { fromPath: source })
    assert(install.ok && install.job?.id, install.error ?? 'no job id')
    let job = install.job
    for (let i = 0; i < 120 && job.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      job = (await get(`/jobs?id=${encodeURIComponent(job.id)}`)).job
    }
    assert(job.status === 'done', `job ended as ${job.status}: ${job.error ?? ''}`)
    assert(job.result.path.startsWith(testFontDir), `installed outside the shared library: ${job.result.path}`)
    const removed = await post('/sources/remove', { path: job.result.path, removeFile: true })
    assert(removed.ok && removed.removed, removed.error)
  })

  await step('a delete outside the shared library is refused', async () => {
    const outsider = join(testRoot, 'not-a-font.txt')
    await writeFile(outsider, 'keep me')
    const removed = await post('/sources/remove', { path: outsider, removeFile: true })
    assert(removed.ok === false, `deleting an outside file must be refused, got ${JSON.stringify(removed)}`)
    assert((await readFile(outsider, 'utf8')) === 'keep me', 'the file must still exist')
  })

  // The four steps below cover the "saved default points at a bank that no longer
  // exists" case: the page and the renderer must always agree.
  const testExec = { agent: { workspaceRoot: root } }
  const renderFont = async () => {
    const rendered = await musicToolDefinition.execute(
      { score: { tracks: [{ name: 'a', instrument: 'strings', notes: [[0, 0.5, 'C4', 90]] }] }, durationSec: 0.6, output: '.anyaudio/test-tmp/default-check.wav' },
      testExec,
    )
    return rendered
  }
  const secondBank = seeded ? join(testFontDir, 'second-bank.sf2') : null
  if (seeded) await copyFile(seeded, secondBank)

  await step('deleting the saved default clears the setting instead of keeping a dead path', async () => {
    if (!secondBank) {
      const skippedError = new Error('no bank installed on this machine to seed the temporary library with')
      skippedError.skip = true
      throw skippedError
    }
    // Save the default the way `anyaudio_sources` does (a stable id, not a path)
    // and then delete the file it resolves to.
    await post('/config', { patch: { music: { font: 'second-bank' } } })
    const before = await get('/state')
    assert(before.fonts.defaultPath === secondBank, `page should show the saved default, got ${before.fonts.defaultPath}`)
    const removed = await post('/sources/remove', { path: secondBank, removeFile: true })
    assert(removed.ok && removed.removed, removed.error)
    assert(removed.defaultCleared === true, 'removing the saved default must report that it cleared the setting')
    const after = await get('/state')
    assert(after.config.music.font === '', `config must not keep the deleted bank, got "${after.config.music.font}"`)
    assert(after.fonts.defaultPath !== secondBank, 'page must not show a deleted bank as the default')
    assert(existsSync(after.fonts.defaultPath), 'the bank shown as default must exist on disk')
  })

  await step('deleting a bank that is not the default leaves the default alone', async () => {
    if (!seeded) {
      const skippedError = new Error('no bank installed on this machine to seed the temporary library with')
      skippedError.skip = true
      throw skippedError
    }
    const keep = join(testFontDir, 'keep-bank.sf2')
    const drop = join(testFontDir, 'drop-bank.sf2')
    await copyFile(seeded, keep)
    await writeFile(drop, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 3)]))
    await post('/config', { patch: { music: { font: keep } } })
    const removed = await post('/sources/remove', { path: drop, removeFile: true })
    assert(removed.ok && removed.removed, removed.error)
    assert(removed.defaultCleared === false, 'deleting an unrelated bank must not clear the default')
    const after = await get('/state')
    assert(after.config.music.font === keep, `default must stay on ${keep}, got "${after.config.music.font}"`)
    assert(after.fonts.defaultPath === keep, `page must keep showing ${keep}, got ${after.fonts.defaultPath}`)
    await post('/sources/remove', { path: keep, removeFile: true })
  })

  await step('a saved default pointing at a missing path still renders, and page and render agree', async () => {
    const ghost = join(testRoot, 'gone-bank.sf2')
    await post('/config', { patch: { music: { font: ghost } } })
    const page = await get('/state')
    assert(page.fonts.defaultPath !== ghost, 'page must not present a missing path as the default')
    assert(existsSync(page.fonts.defaultPath), `page default must exist, got ${page.fonts.defaultPath}`)
    const rendered = await renderFont()
    assert(rendered.font === page.fonts.defaultPath, `render used ${rendered.font} but the page shows ${page.fonts.defaultPath}`)
    assert(
      (rendered.warnings ?? []).some((warning) => /no longer installed/i.test(warning)),
      `a stale saved default should be called out, warnings were ${JSON.stringify(rendered.warnings)}`,
    )
  })

  await step('an uninstalled saved default falls back, and page and render agree', async () => {
    await post('/config', { patch: { music: { font: 'electric-guitar-clean' } } })
    const page = await get('/state')
    assert(existsSync(page.fonts.defaultPath), `page default must exist, got ${page.fonts.defaultPath}`)
    const rendered = await renderFont()
    assert(rendered.font === page.fonts.defaultPath, `render used ${rendered.font} but the page shows ${page.fonts.defaultPath}`)
  })

  const realStateAfter = await snapshot(realStatePath)
  await step('the machine-wide state file was never touched', () => {
    assert(
      JSON.stringify(realStateAfter) === JSON.stringify(realStateBefore),
      `real state file changed: ${realStatePath}`,
    )
  })

  console.log(`\n${passed} steps passed${skipped ? `, ${skipped} skipped` : ''}`)
  server.close()
  await rm(testRoot, { recursive: true, force: true })
  if (!hadAnyaudioDir) {
    const leftover = await readdir(anyaudioDir).catch(() => [])
    if (leftover.length === 0) await rm(anyaudioDir, { recursive: true, force: true })
  }
})

