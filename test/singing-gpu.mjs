// GPU component acceptance: local fake HTTP mirrors + injected pip/provider,
// no internet and no writes to the real ~/.dsh/anyaudio/singing.
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GPU_PACKAGE, PROBE_BYTES, __singingGpuTest, gpuSources,
  gpuStatus, installGpuRuntime,
} from '../src/audio/singing-gpu.js'
import {
  registerAnyAudioRoutes, setGpuInstallRunner, setGpuStatusProbe,
} from '../src/host/routes.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(root, '.anyaudio', 'test-singing-gpu')

let passed = 0
let failed = 0
function assert(condition, message) {
  if (!condition) throw new Error(message)
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

const WHEEL_BUF = Buffer.alloc(1024 * 1024, 7)

/**
 * A fake PyPI mirror: the simple index links to its wheel URL, and the wheel
 * endpoint answers Range with a configurable delay so measured speed differs.
 */
function serveMirror({ delayMs = 0, fail = false } = {}) {
  const state = { base: null, wheelUrl: null, probeHits: 0 }
  const server = http.createServer((req, res) => {
    if (fail) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('mirror down')
      return
    }
    if (req.url === `/simple/${GPU_PACKAGE.name}/`) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body><a href="${state.wheelUrl}">${GPU_PACKAGE.wheel}</a></body></html>`)
      return
    }
    if (req.url === `/wheel/${GPU_PACKAGE.wheel}`) {
      state.probeHits++
      setTimeout(() => {
        const range = req.headers.range
        if (range && /^bytes=(\d+)-(\d+)-?/.test(range)) {
          const m = /^bytes=(\d+)-(\d+)/.exec(range)
          const start = Number(m[1]); const end = Math.min(Number(m[2]), WHEEL_BUF.length - 1)
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${start}-${end}/${WHEEL_BUF.length}`,
            'content-length': String(end - start + 1),
          })
          res.end(WHEEL_BUF.subarray(start, end + 1))
          return
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(WHEEL_BUF.length) })
        res.end(WHEEL_BUF)
      }, delayMs)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return { server, state }
}
async function start(mirror) {
  await new Promise((ok) => mirror.server.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${mirror.server.address().port}`
  mirror.state.base = `${base}/simple/`
  mirror.state.wheelUrl = `${base}/wheel/${GPU_PACKAGE.wheel}`
  return { id: `mirror-${mirror.server.address().port}`, label: `镜像${mirror.server.address().port}`, index: mirror.state.base }
}
async function stop(mirror) {
  await new Promise((ok) => mirror.server.close(ok))
}

// ---------------------------------------------------------------------------
// Module-level acceptance
// ---------------------------------------------------------------------------
await step('three sources are measured and the fastest mirror wins', async () => {
  const slow = serveMirror({ delayMs: 220 })
  const fast = serveMirror({ delayMs: 10 })
  const mid = serveMirror({ delayMs: 100 })
  const slowSource = await start(slow)
  const fastSource = await start(fast)
  const midSource = await start(mid)
  const sources = [slowSource, fastSource, midSource]
  const events = []
  const pipCalls = []
  const result = await installGpuRuntime({
    root: testDir,
    sources,
    probeBytes: 256 * 1024,
    onProgress: (e) => events.push(e),
    pipImpl: (python, index, pkg, ctx) => {
      pipCalls.push({ python, index, spec: `${pkg.name}==${pkg.version}` })
      ctx.onProgress?.({ phase: 'gpu-pip', message: `pip ${index}` })
      return Promise.resolve()
    },
    providerImpl: () => Promise.resolve(['CPUExecutionProvider']),
  })
  assert(result.ok === true && result.source === fastSource.id, `expected fastest ${fastSource.id}, got ${result.source}`)
  assert(pipCalls.length === 1, `pip must run once on the winner, got ${pipCalls.length}`)
  assert(pipCalls[0].index === fastSource.index, 'pip must use the fastest mirror')
  assert(pipCalls[0].spec === 'onnxruntime-gpu==1.19.2', 'pip spec wrong')
  assert(events.filter((e) => e.phase === 'gpu-probe' && e.speed > 0).length === 3, 'all three probes must report speed')
  assert(events.some((e) => e.selected === fastSource.id), 'fastest source must be announced')
  for (const m of [slow, fast, mid]) await stop(m)
})

await step('probe failure is skipped; a failing pip source swaps to the next', async () => {
  const down = serveMirror({ fail: true })
  const good = serveMirror({ delayMs: 10 })
  const good2 = serveMirror({ delayMs: 15 })
  const downSource = await start(down)
  const goodSource = await start(good)
  const good2Source = await start(good2)
  const sources = [downSource, goodSource, good2Source]
  const events = []
  const pipCalls = []
  const result = await installGpuRuntime({
    root: testDir,
    sources,
    probeBytes: 256 * 1024,
    onProgress: (e) => events.push(e),
    pipImpl: (python, index, pkg, ctx) => {
      pipCalls.push(index)
      // The fastest healthy mirror (good) fails its install; must fall to good2.
      if (index === goodSource.index) return Promise.reject(new Error('pip 500'))
      return Promise.resolve()
    },
    providerImpl: () => Promise.resolve(['CUDAExecutionProvider']),
  })
  assert(down.state.probeHits === 0, 'a down mirror must not be downloading the wheel')
  assert(events.some((e) => e.phase === 'gpu-probe' && e.error && e.source === downSource.id), 'down mirror must be reported as skipped')
  assert(pipCalls.length === 2, `pip should try two healthy sources, got ${pipCalls.length}`)
  assert(pipCalls[0] === goodSource.index && pipCalls[1] === good2Source.index, 'pip must fall through to the second source')
  assert(result.source === good2Source.id, 'result must report the source that actually succeeded')
  for (const m of [down, good, good2]) await stop(m)
})

await step('all sources failing gives one clear GPU_INSTALL_FAILED error', async () => {
  const a = serveMirror({ fail: true })
  const b = serveMirror({ fail: true })
  const sources = [await start(a), await start(b)]
  let error = null
  try {
    await installGpuRuntime({
      root: testDir, sources, probeBytes: 256 * 1024,
      // Every mirror's probe AND install fails → one clear tagged error.
      pipImpl: () => Promise.reject(new Error('pip 500')),
      providerImpl: () => Promise.resolve([]),
    })
  } catch (e) { error = e }
  assert(error && error.code === 'GPU_INSTALL_FAILED', `expected GPU_INSTALL_FAILED, got ${error?.code}: ${error?.message}`)
  for (const m of [a, b]) await stop(m)
})

await step('status detects an installed dist-info and CUDA provider', async () => {
  const gpuRoot = join(testDir, 'status-installed')
  await rm(gpuRoot, { recursive: true, force: true })
  const dist = join(gpuRoot, 'runtime', 'Lib', 'site-packages', 'onnxruntime_gpu-1.19.2.dist-info')
  await mkdir(dist, { recursive: true })
  await writeFile(join(dist, 'METADATA'), 'Name: onnxruntime-gpu\nVersion: 1.19.2\n')
  const status = await gpuStatus({
    root: gpuRoot,
    providerImpl: () => Promise.resolve(['CUDAExecutionProvider', 'CPUExecutionProvider']),
  })
  assert(status.installed === true, 'dist-info must be detected as installed')
  assert(status.version === '1.19.2', `version wrong: ${status.version}`)
  assert(status.cudaAvailable === true, 'CUDA provider must be reported')
  assert(status.providers.includes('CUDAExecutionProvider'), 'providers must include CUDA')
})

await step('status reports not-installed on a clean runtime (no provider spawn)', async () => {
  const clean = join(testDir, 'status-clean')
  await rm(clean, { recursive: true, force: true })
  const status = await gpuStatus({ root: clean })
  assert(status.installed === false, 'clean runtime must report not installed')
  assert(status.cudaAvailable === false, 'no CUDA without an install')
  assert(status.providers === null, 'no provider probe on a clean runtime')
})

await step('public mirror list has the three expected sources', async () => {
  const sources = gpuSources()
  assert(sources.length === 3, `expected 3 sources, got ${sources.length}`)
  assert(sources.some((s) => s.index.includes('tuna')), 'Tsinghua mirror missing')
  assert(sources.some((s) => s.index.includes('aliyun')), 'Aliyun mirror missing')
  assert(sources.some((s) => s.index.includes('pypi.org')), 'official PyPI missing')
  assert(GPU_PACKAGE.wheel.includes('cp312-cp312-win_amd64'), 'wheel must match Python 3.12 / win amd64')
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

await step('GET singing/gpu-status goes through the real route', async () => {
  setGpuStatusProbe(() => Promise.resolve({ ok: true, installed: true, version: '1.19.2', cudaAvailable: true, providers: ['CUDAExecutionProvider'] }))
  const status = await apiGet('/singing/gpu-status')
  assert(status.ok && status.installed === true && status.cudaAvailable === true, `gpu-status route: ${JSON.stringify(status)}`)
  setGpuStatusProbe(undefined)
})

await step('POST singing/gpu-install joins a running job and exposes progress', async () => {
  let resolveJob
  setGpuInstallRunner(({ onProgress }) => {
    onProgress?.({ phase: 'gpu-probe', message: '测速 清华', source: 'tuna', speed: 123 })
    return new Promise((ok) => { resolveJob = ok })
  })
  const first = await apiPost('/singing/gpu-install', {})
  assert(first.ok && first.job?.status === 'running', `first gpu-install: ${JSON.stringify(first)}`)
  const second = await apiPost('/singing/gpu-install', {})
  assert(second.reused === true && second.job.id === first.job.id, 'gpu-install must reuse the running job')
  const active = await apiGet('/jobs/active?kind=singing-gpu-install')
  assert(active.job?.id === first.job.id, 'running gpu-install must be discoverable')
  resolveJob({ ok: true, source: 'tuna' })
  await new Promise((ok) => setTimeout(ok, 50))
  const done = await apiGet(`/jobs?id=${encodeURIComponent(first.job.id)}`)
  assert(done.job.status === 'done', `job should be done, got ${done.job.status}`)
  assert(done.job.message === 'ready', `job message should be ready, got ${done.job.message}`)
  setGpuInstallRunner(undefined)
})

setGpuInstallRunner(undefined)
setGpuStatusProbe(undefined)
await new Promise((ok) => api.close(ok))
await rm(testDir, { recursive: true, force: true })

console.log(`\n${passed}/${passed + failed} passed`)
process.exit(failed ? 1 : 0)
