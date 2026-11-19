// M4 installer acceptance: a local fake HTTP server + redirected root, no
// internet and no writes to the real ~/.dsh/anyaudio/singing.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  __singingInstallTest, defaultManifest, installVoicebankFromZip, listSingingVoices,
  runSingingInstall, sha256File, singingRoot, singingStatus,
  VOICEBANK_SOURCES,
} from '../src/audio/singing-install.js'
import {
  registerAnyAudioRoutes, setSingingInstallRunner, setVoicebankZipInstaller,
} from '../src/host/routes.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(root, '.anyaudio', 'test-singing-install')

let passed = 0
let failed = 0
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function sha(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function step(name, fn) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
}

/** A tiny Range-capable HTTP server serving one buffer, with optional failure. */
function serveBuffer(buf, { fail = false } = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers.range ?? null)
    if (fail) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('mirror down')
      return
    }
    const range = req.headers.range
    if (range && /^bytes=(\d+)-/.test(range)) {
      const start = Number(/^bytes=(\d+)-/.exec(range)[1])
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}`,
        'content-length': String(buf.length - start),
      })
      res.end(buf.subarray(start))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(buf.length),
    })
    res.end(buf)
  })
  return { server, seen, url: null }
}
async function start(server) {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return `http://127.0.0.1:${server.address().port}/asset`
}
async function stop(server) {
  await new Promise((ok) => server.close(ok))
}

/** Fake extract: create just the marker files the installer checks for. */
function fakeExtract(archive, dest, ctx) {
  const name = archive.split(/[\\/]/).pop()
  ctx.onProgress?.({ phase: ctx.phase, message: `fake-extract ${name}` })
  if (name.includes('python')) {
    return mkdir(dest, { recursive: true }).then(() =>
      writeFile(join(dest, process.platform === 'win32' ? 'python.exe' : 'python'), 'fake'))
  }
  // Standalone vocoder package: tar entries land directly in dsvocoder/, so
  // the fake extract writes vocoder.yaml at the destination root.
  if (name.includes('oudep')) {
    return mkdir(dest, { recursive: true }).then(() =>
      writeFile(join(dest, 'vocoder.yaml'), 'staged vocoder'))
  }
  // Any voicebank zip: nest one folder named after the zip (like Lianhua /
  // Qixuan both do) containing dsconfig.yaml. Vocoder is optional and driven
  // by ctx.withVocoder so a third-party bank without one can be exercised.
  const folder = name.replace(/\.(zip|oudep)$/i, '')
  const bank = join(dest, folder)
  return (async () => {
    await mkdir(bank, { recursive: true })
    await writeFile(join(bank, 'dsconfig.yaml'), 'bank')
    if (ctx.withVocoder !== false) {
      await mkdir(join(bank, 'dsvocoder'), { recursive: true })
      await writeFile(join(bank, 'dsvocoder', 'vocoder.yaml'), 'vocoder')
    }
  })()
}

const RUNTIME_BUF = Buffer.from('fake runtime archive payload'.repeat(20))
const BANK_BUF = Buffer.from('fake voicebank zip payload'.repeat(40))
const VOCODER_BUF = Buffer.from('fake vocoder payload'.repeat(30))
const BUFFER_EMPTY = Buffer.alloc(0)

function localManifest({ runtimeUrl, vocUrl } = {}) {
  const m = defaultManifest()
  m.runtime.urls = [runtimeUrl]
  m.runtime.sha256 = sha(RUNTIME_BUF)
  m.vocoder.urls = [vocUrl]
  m.vocoder.sha256 = sha(VOCODER_BUF)
  return m
}

const pipCalls = []
const fakePip = (python, group, ctx) => {
  pipCalls.push({ python, group: group.label, specs: group.specs, index: group.index })
  ctx.onProgress?.({ phase: 'pip', message: `pip ${group.label}` })
  return Promise.resolve()
}

// ---------------------------------------------------------------------------
// Module-level acceptance
// ---------------------------------------------------------------------------
const runtimeServer = serveBuffer(RUNTIME_BUF)
const bankServer = serveBuffer(BANK_BUF)
const vocServer = serveBuffer(VOCODER_BUF)
const runtimeUrl = await start(runtimeServer.server)
const bankUrl = await start(bankServer.server)
const vocUrl = await start(vocServer.server)

await step('install from empty dir: runtime + STAGED vocoder + pip deps, NO voicebank download', async () => {
  await rm(testDir, { recursive: true, force: true })
  const events = []
  const status = await runSingingInstall({
    root: testDir,
    manifest: localManifest({ runtimeUrl, vocUrl }),
    extractImpl: fakeExtract,
    pipImpl: fakePip,
    onProgress: (e) => events.push(e),
  })
  // Runtime must be ready; a voicebank is a separate user-driven step.
  assert(status.runtime.installed === true, 'runtime must be installed')
  assert(existsSync(join(testDir, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python')), 'runtime python missing')
  // Vocoder is downloaded to downloads/ but NOT unpacked into any voicebank.
  const staged = join(testDir, 'downloads', defaultManifest().vocoder.file)
  assert(existsSync(staged), 'vocoder must be staged under downloads/')
  assert(sha(await readFile(staged)) === sha(VOCODER_BUF), 'staged vocoder content mismatch')
  assert(vocServer.seen.length === 1, `vocoder must be fetched once, saw ${vocServer.seen.length}`)
  // No voicebank was downloaded or created — that is the whole decoupling.
  assert(bankServer.seen.length === 0, 'the install job must NOT download a voicebank zip')
  assert(existsSync(join(testDir, 'voicebank')) === false, 'install job must not create a voicebank dir')
  assert(events.some((e) => e.received > 0 && e.total >= e.received), 'progress must report received/total')
  assert(pipCalls.length === 2, `expected 2 pip groups, got ${pipCalls.length}`)
  assert(pipCalls.some((c) => c.specs.includes('diffsinger-utau==0.3.8')), 'diffsinger-utau pin missing')
})

await step('SHA-256 mismatch rejects the artifact and does not install it', async () => {
  const badRoot = join(testDir, 'bad-sha')
  await rm(badRoot, { recursive: true, force: true })
  const bad = localManifest({ runtimeUrl, vocUrl })
  bad.runtime.sha256 = '0'.repeat(64)
  let error = null
  try {
    await runSingingInstall({
      root: badRoot, manifest: bad, extractImpl: fakeExtract, pipImpl: fakePip,
    })
  } catch (e) { error = e }
  assert(error && /SHA-256 mismatch/.test(error.message), `expected sha error, got ${error?.message}`)
  assert(!existsSync(join(badRoot, 'runtime')), 'a bad archive must not be extracted')
})

await step('mirror failure falls back to the next URL', async () => {
  const down = serveBuffer(BUFFER_EMPTY, { fail: true })
  const downUrl = await start(down.server)
  const goodServer = serveBuffer(RUNTIME_BUF)
  const goodUrl = await start(goodServer.server)
  const m = localManifest({ runtimeUrl: goodUrl, vocUrl })
  m.runtime.urls = [downUrl, goodUrl]
  const fallbackRoot = join(testDir, 'fallback')
  await rm(fallbackRoot, { recursive: true, force: true })
  const status = await runSingingInstall({
    root: fallbackRoot, manifest: m, extractImpl: fakeExtract, pipImpl: fakePip,
  })
  assert(status.runtime.installed, 'fallback install must succeed')
  await stop(down.server); await stop(goodServer.server)
})

await step('resumable download: no Range on a fresh file, Range when .part exists', async () => {
  const partRoot = join(testDir, 'resume')
  await rm(partRoot, { recursive: true, force: true })
  await mkdir(partRoot, { recursive: true })
  const dest = join(partRoot, 'asset.bin')
  const { downloadUrl } = __singingInstallTest
  // Fresh file: no Range header.
  await downloadUrl(runtimeUrl, dest, { sha256: sha(RUNTIME_BUF) })
  assert(runtimeServer.seen[0] === null, `fresh download must not send Range, saw ${runtimeServer.seen[0]}`)
  assert(sha(await readFile(dest)) === sha(RUNTIME_BUF), 'fresh download content mismatch')
  // Simulate an interrupted transfer: keep half, then resume.
  const half = Math.floor(RUNTIME_BUF.length / 2)
  await writeFile(`${dest}.part`, RUNTIME_BUF.subarray(0, half))
  const seenBefore = runtimeServer.seen.length
  await downloadUrl(runtimeUrl, dest, { sha256: sha(RUNTIME_BUF) })
  assert(runtimeServer.seen[seenBefore] === `bytes=${half}-`, `resume must send Range bytes=${half}-, saw ${runtimeServer.seen[seenBefore]}`)
  assert(sha(await readFile(dest)) === sha(RUNTIME_BUF), 'resumed content mismatch')
})

await step('status reflects the installed runtime; voices scans the voicebank dir', async () => {
  process.env.ANYAUDIO_SINGING_DIR = testDir
  const status = await singingStatus()
  assert(status.runtime.installed === true, 'runtime must be reported installed')
  assert(status.root === testDir, `root redirected to ${status.root}`)
  // No voicebank is installed by the runtime job: ready is false until one is added.
  assert(status.voicebank.installed === false, 'runtime-only install must not imply a voicebank')
  const voices = await listSingingVoices()
  assert(Array.isArray(voices.voices), 'voices must be a list')
})

// ---------------------------------------------------------------------------
// Route-level acceptance (mounted on a local server, no network)
// ---------------------------------------------------------------------------
let handler
const webServer = { register: (route) => { handler = route.handler; return () => {} } }
const ctx = {
  get: (id) => (id === 'webServer' ? webServer : undefined),
  inject: (_, fn) => fn(ctx),
  effect: (fn) => fn(),
  logger: { info: () => {} },
}
registerAnyAudioRoutes(ctx, { log: { info: () => {} }, workspaceRoot: root })
const api = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
  })
})
await new Promise((ok) => api.listen(0, '127.0.0.1', ok))
const apiBase = `http://127.0.0.1:${api.address().port}/api/dsh-any-audio`
async function apiGet(path) {
  const r = await fetch(apiBase + path, { headers: { 'x-any-audio-client': 'any-audio/1' } })
  return r.json()
}
async function apiPost(path, body = {}) {
  const r = await fetch(apiBase + path, {
    method: 'POST',
    headers: { 'x-any-audio-client': 'any-audio/1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

await step('GET singing/status and singing/voices through the real routes', async () => {
  const status = await apiGet('/singing/status')
  assert(status.ok && status.runtime?.installed === true, `status route: ${JSON.stringify(status)}`)
  const voices = await apiGet('/singing/voices')
  assert(voices.ok && Array.isArray(voices.voices), 'voices route shape')
})

await step('POST singing/install reuses the running job (idempotent)', async () => {
  let resolveJob
  setSingingInstallRunner(() => new Promise((ok) => { resolveJob = ok }))
  const first = await apiPost('/singing/install', {})
  assert(first.ok && first.job?.status === 'running', `first install job: ${JSON.stringify(first)}`)
  const second = await apiPost('/singing/install', {})
  assert(second.reused === true, 'second install must reuse the running job')
  assert(second.job.id === first.job.id, `parallel install started: ${second.job.id} != ${first.job.id}`)
  const active = await apiGet(`/jobs/active?kind=singing-install`)
  assert(active.job?.id === first.job.id, 'reopened page must find the running install')
  resolveJob({ ready: true })
  setSingingInstallRunner(undefined)
  // Wait briefly for the job to settle.
  await new Promise((ok) => setTimeout(ok, 50))
  const done = await apiGet(`/jobs?id=${encodeURIComponent(first.job.id)}`)
  assert(done.job.status === 'done', `job should be done, got ${done.job.status}`)
})

await step('progress is pollable through the jobs route', async () => {
  setSingingInstallRunner(async ({ onProgress }) => {
    onProgress?.({ phase: 'voicebank-download', received: 50, total: 100 })
  })
  const started = await apiPost('/singing/install', {})
  await new Promise((ok) => setTimeout(ok, 50))
  const job = (await apiGet(`/jobs?id=${encodeURIComponent(started.job.id)}`)).job
  assert(job.received === 50 && job.total === 100, `progress not reported: ${JSON.stringify(job)}`)
  assert(typeof job.status === 'string', 'job status must be pollable')
  setSingingInstallRunner(undefined)
})

// ---------------------------------------------------------------------------
// Local-zip install + source list (t12)
// ---------------------------------------------------------------------------
await step('voicebank sources expose GitHub / Baidu / Quark links', async () => {
  assert(VOICEBANK_SOURCES.length === 3, `expected 3 sources, got ${VOICEBANK_SOURCES.length}`)
  assert(VOICEBANK_SOURCES.map((s) => s.id).join(',') === 'github,baidu,quark', 'source ids wrong')
  assert(VOICEBANK_SOURCES.find((s) => s.id === 'github').url.startsWith('https://github.com/'), 'github link wrong')
  assert(VOICEBANK_SOURCES.find((s) => s.id === 'baidu').url.includes('pan.baidu.com'), 'baidu link wrong')
  assert(VOICEBANK_SOURCES.find((s) => s.id === 'quark').url.includes('pan.quark.cn'), 'quark link wrong')
})

await step('local third-party zip installs WITHOUT any SHA check, nested folder归位', async () => {
  const zipRoot = join(testDir, 'local-zip')
  await rm(zipRoot, { recursive: true, force: true })
  await mkdir(zipRoot, { recursive: true })
  // A made-up third-party bank with arbitrary content (NOT the Qixuan digest).
  const zip = join(zipRoot, 'Lianhua_DiffSinger_v2.1.50_beta.zip')
  await writeFile(zip, Buffer.from('some third-party bank bytes, no official digest'))
  const events = []
  const status = await installVoicebankFromZip({
    root: zipRoot, zipPath: zip, extractImpl: fakeExtract, onProgress: (e) => events.push(e),
  })
  assert(status.name === 'Lianhua_DiffSinger_v2.1.50_beta', `name wrong: ${status.name}`)
  assert(status.voicebank.installed, 'voicebank not installed from local zip')
  // 嵌套一层文件夹被归位到 voicebank/<name>/dsconfig.yaml
  assert(existsSync(join(zipRoot, 'voicebank', 'Lianhua_DiffSinger_v2.1.50_beta', 'dsconfig.yaml')), 'nested bank not归位')
  // 声库自带声码器（内容为 'vocoder'）必须被保留，不能被暂存包覆盖。
  const ownVoc = join(zipRoot, 'voicebank', 'Lianhua_DiffSinger_v2.1.50_beta', 'dsvocoder', 'vocoder.yaml')
  assert(existsSync(ownVoc), 'self-shipped vocoder missing')
  assert((await readFile(ownVoc, 'utf8')) === 'vocoder', 'self-shipped vocoder must NOT be overwritten')
  // listSingingVoices 能扫到，下拉框可见
  const voices = await listSingingVoices({ root: zipRoot })
  assert(voices.voices.some((v) => v.name === 'Lianhua_DiffSinger_v2.1.50_beta'), 'voicebank not discoverable')
  assert(existsSync(join(zipRoot, '.voicebank-stage')) === false, 'staging dir should be cleaned')
})

await step('local zip WITHOUT dsvocoder still installs (only dsconfig.yaml required)', async () => {
  const novoc = join(testDir, 'local-novoc')
  await rm(novoc, { recursive: true, force: true })
  await mkdir(novoc, { recursive: true })
  const zip = join(novoc, 'MyCustomBank.zip')
  await writeFile(zip, Buffer.from('custom bank no vocoder'))
  const status = await installVoicebankFromZip({
    root: novoc, zipPath: zip,
    extractImpl: (archive, dest, ctx) => fakeExtract(archive, dest, { ...ctx, withVocoder: false }),
  })
  assert(status.voicebank.installed, 'bank without vocoder must still install')
  assert(existsSync(join(novoc, 'voicebank', 'MyCustomBank', 'dsconfig.yaml')), 'dsconfig missing')
  // No staged package in this root, so no vocoder is conjured out of thin air.
  assert(existsSync(join(novoc, 'voicebank', 'MyCustomBank', 'dsvocoder', 'vocoder.yaml')) === false, 'should not have vocoder')
})

await step('staged vocoder is extracted into a bank that ships none (vocoder.yaml present)', async () => {
  const fill = join(testDir, 'vocoder-fill')
  await rm(fill, { recursive: true, force: true })
  const m = localManifest({ runtimeUrl, vocUrl })
  // Stage the vocoder in this root exactly as runSingingInstall would.
  await runSingingInstall({ root: fill, manifest: m, extractImpl: fakeExtract, pipImpl: fakePip })
  const staged = join(fill, 'downloads', defaultManifest().vocoder.file)
  assert(existsSync(staged), 'precondition: staged vocoder missing')
  const zip = join(fill, 'PlainBank.zip')
  await writeFile(zip, Buffer.from('bank without own vocoder'))
  const status = await installVoicebankFromZip({
    root: fill, zipPath: zip, manifest: m,
    extractImpl: (archive, dest, ctx) => fakeExtract(archive, dest, { ...ctx, withVocoder: false }),
  })
  assert(status.voicebank.installed, 'voicebank must install')
  const vocPath = join(fill, 'voicebank', 'PlainBank', 'dsvocoder', 'vocoder.yaml')
  assert(existsSync(vocPath), 'staged vocoder must be归位 into dsvocoder/vocoder.yaml')
  assert(status.vocoder.installed === true, 'status.vocoder.installed must reflect归位')
  assert(status.ready === true, 'status.ready must be true once vocoder归位')
})

await step('repeat runSingingInstall does NOT re-download a verified staged vocoder', async () => {
  const repeatRoot = join(testDir, 'repeat-env')
  await rm(repeatRoot, { recursive: true, force: true })
  const m = localManifest({ runtimeUrl, vocUrl })
  const before = vocServer.seen.length
  await runSingingInstall({ root: repeatRoot, manifest: m, extractImpl: fakeExtract, pipImpl: fakePip })
  const afterFirst = vocServer.seen.length
  assert(afterFirst === before + 1, 'first install must fetch vocoder once')
  const events = []
  await runSingingInstall({
    root: repeatRoot, manifest: m, extractImpl: fakeExtract, pipImpl: fakePip,
    onProgress: (e) => events.push(e),
  })
  assert(vocServer.seen.length === afterFirst, 'repeat install must NOT re-download vocoder')
  assert(events.some((e) => String(e.message).includes('already staged')), 'repeat install should report skip')
})

await step('local zip with no dsconfig.yaml anywhere is rejected (BAD_ARCHIVE)', async () => {
  const badRoot = join(testDir, 'local-bad')
  await rm(badRoot, { recursive: true, force: true })
  await mkdir(badRoot, { recursive: true })
  const zip = join(badRoot, 'NotABank.zip')
  await writeFile(zip, Buffer.from('garbage'))
  let error = null
  try {
    await installVoicebankFromZip({
      root: badRoot, zipPath: zip,
      extractImpl: () => Promise.resolve(), // extracts nothing
    })
  } catch (e) { error = e }
  assert(error && error.code === 'BAD_ARCHIVE', `expected BAD_ARCHIVE, got ${error?.code}: ${error?.message}`)
  assert(existsSync(join(badRoot, '.voicebank-stage')) === false, 'staging must be cleaned on failure')
})

await step('GET singing/sources and POST singing/install-zip through the routes', async () => {
  const sources = await apiGet('/singing/sources')
  assert(sources.ok && sources.sources?.length === 3, `sources route: ${JSON.stringify(sources)}`)
  let seenZip
  setVoicebankZipInstaller(({ zipPath }) => {
    seenZip = zipPath
    return Promise.resolve({ ok: true, ready: true })
  })
  const installed = await apiPost('/singing/install-zip', { zipPath: 'D:\\fake\\qixuan.zip' })
  assert(installed.ok === true, `install-zip route: ${JSON.stringify(installed)}`)
  assert(seenZip === 'D:\\fake\\qixuan.zip', 'zipPath not forwarded to installer')
  const missing = await apiPost('/singing/install-zip', {})
  assert(missing.ok === false && missing.code === 'BAD_ZIP_PATH', 'missing zipPath must be rejected')
  setVoicebankZipInstaller(undefined)
})

setSingingInstallRunner(undefined)
setVoicebankZipInstaller(undefined)
await stop(runtimeServer.server)
await stop(bankServer.server)
await stop(vocServer.server)
await new Promise((ok) => api.close(ok))
await rm(testDir, { recursive: true, force: true })
delete process.env.ANYAUDIO_SINGING_DIR

console.log(`\n${passed}/${passed + failed} passed`)
process.exit(failed ? 1 : 0)
