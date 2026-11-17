// M4 installer acceptance: a local fake HTTP server + redirected root, no
// internet and no writes to the real ~/.dsh/anyaudio/singing.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  __singingInstallTest, defaultManifest, listSingingVoices, runSingingInstall,
  sha256File, singingRoot, singingStatus,
} from '../src/audio/singing-install.js'
import { registerAnyAudioRoutes, setSingingInstallRunner } from '../src/host/routes.js'

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
  if (name.includes('Qixuan')) {
    const bank = join(dest, 'Qixuan_v2.7.0_DiffSinger_OpenUtau')
    return mkdir(bank, { recursive: true }).then(() => writeFile(join(bank, 'dsconfig.yaml'), 'bank'))
  }
  if (name.includes('oudep')) {
    return mkdir(dest, { recursive: true }).then(() => writeFile(join(dest, 'vocoder.yaml'), 'vocoder'))
  }
  throw new Error(`unknown archive ${name}`)
}

const RUNTIME_BUF = Buffer.from('fake runtime archive payload'.repeat(20))
const BANK_BUF = Buffer.from('fake voicebank zip payload'.repeat(40))
const VOCODER_BUF = Buffer.from('fake vocoder payload'.repeat(30))
const BUFFER_EMPTY = Buffer.alloc(0)

function localManifest({ runtimeUrl, bankUrl, vocUrl } = {}) {
  const m = defaultManifest()
  m.runtime.urls = [runtimeUrl]
  m.runtime.sha256 = sha(RUNTIME_BUF)
  m.voicebank.urls = [bankUrl]
  m.voicebank.sha256 = sha(BANK_BUF)
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

await step('install from empty dir: runtime + voicebank + vocoder land with markers', async () => {
  await rm(testDir, { recursive: true, force: true })
  const events = []
  const status = await runSingingInstall({
    root: testDir,
    manifest: localManifest({ runtimeUrl, bankUrl, vocUrl }),
    extractImpl: fakeExtract,
    pipImpl: fakePip,
    onProgress: (e) => events.push(e),
  })
  assert(status.ready === true, 'status.ready must be true after install')
  assert(existsSync(join(testDir, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python')), 'runtime python missing')
  assert(existsSync(join(testDir, 'voicebank', 'Qixuan_v2.7.0_DiffSinger_OpenUtau', 'dsconfig.yaml')), 'dsconfig.yaml missing')
  assert(existsSync(join(testDir, 'voicebank', 'Qixuan_v2.7.0_DiffSinger_OpenUtau', 'dsvocoder', 'vocoder.yaml')), 'vocoder.yaml missing')
  assert(events.some((e) => e.received > 0 && e.total >= e.received), 'progress must report received/total')
  assert(pipCalls.length === 2, `expected 2 pip groups, got ${pipCalls.length}`)
  assert(pipCalls.some((c) => c.specs.includes('diffsinger-utau==0.3.8')), 'diffsinger-utau pin missing')
})

await step('SHA-256 mismatch rejects the artifact and does not install it', async () => {
  const badRoot = join(testDir, 'bad-sha')
  await rm(badRoot, { recursive: true, force: true })
  const bad = defaultManifest()
  bad.runtime.urls = [runtimeUrl]
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
  const m = localManifest({ runtimeUrl: `${downUrl}|${goodUrl}`, bankUrl, vocUrl })
  m.runtime.urls = [downUrl, goodUrl]
  const fallbackRoot = join(testDir, 'fallback')
  await rm(fallbackRoot, { recursive: true, force: true })
  // Reuse installed bank/vocoder from the main root to keep this step focused.
  await mkdir(join(fallbackRoot, 'voicebank', 'Qixuan_v2.7.0_DiffSinger_OpenUtau', 'dsvocoder'), { recursive: true })
  await writeFile(join(fallbackRoot, 'voicebank', 'Qixuan_v2.7.0_DiffSinger_OpenUtau', 'dsconfig.yaml'), 'bank')
  await writeFile(join(fallbackRoot, 'voicebank', 'Qixuan_v2.7.0_DiffSinger_OpenUtau', 'dsvocoder', 'vocoder.yaml'), 'vocoder')
  const status = await runSingingInstall({
    root: fallbackRoot, manifest: m, extractImpl: fakeExtract, pipImpl: fakePip,
  })
  assert(status.ready, 'fallback install must succeed')
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

await step('status and voices reflect an installed environment', async () => {
  process.env.ANYAUDIO_SINGING_DIR = testDir
  const status = await singingStatus()
  assert(status.ready === true, 'status must be ready for the installed root')
  assert(status.root === testDir, `root redirected to ${status.root}`)
  const voices = await listSingingVoices()
  assert(voices.voices.some((v) => v.name === 'Qixuan_v2.7.0_DiffSinger_OpenUtau'), 'voicebank not listed')
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
  assert(status.ok && status.ready === true, `status route: ${JSON.stringify(status)}`)
  const voices = await apiGet('/singing/voices')
  assert(voices.ok && voices.voices.length >= 1, 'voices route empty')
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

setSingingInstallRunner(undefined)
await stop(runtimeServer.server)
await stop(bankServer.server)
await stop(vocServer.server)
await new Promise((ok) => api.close(ok))
await rm(testDir, { recursive: true, force: true })
delete process.env.ANYAUDIO_SINGING_DIR

console.log(`\n${passed}/${passed + failed} passed`)
process.exit(failed ? 1 : 0)
