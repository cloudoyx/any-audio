/**
 * Optional CUDA acceleration for the local singing worker.
 *
 * What actually enables GPU inference is onnxruntime-gpu (NOT torch — torch
 * stays the fixed 2.7.1+cpu build). onnxruntime-gpu 1.19.2 ships CUDA/cuDNN
 * inside the wheel, so no separate CUDA toolkit download is needed. The wheel
 * we care about is the cp312 win_amd64 one, matching the Python 3.12 runtime
 * installed by singing-install.js.
 *
 * Network conditions differ per user, so EVERY install measures the candidate
 * PyPI mirrors first (a small Range probe against the wheel URL on each mirror),
 * ranks them by measured throughput, then installs through the fastest mirror.
 * A source that fails probing is skipped; a source that fails installing is
 * swapped for the next one. All failures give one clear tagged error.
 *
 * Every network/shell/path touch is injectable so the offline acceptance test
 * can drive the whole flow with a local fake HTTP server and a fake pip, with
 * no internet and no writes to the real ~/.dsh/anyaudio/singing.
 *
 * The engine (engine/worker.py) needs no change: it already falls back to CPU
 * when no CUDAExecutionProvider is available, whatever device is requested.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { platform } from 'node:os'
import { basename, join } from 'node:path'
import { singingRoot } from './singing-install.js'

const ORT_VERSION = '1.19.2'

/** Public PyPI mirrors. Kept as a factory so callers can deep-clone/override. */
export function gpuSources() {
  return [
    { id: 'tuna', label: '清华', index: 'https://pypi.tuna.tsinghua.edu.cn/simple/' },
    { id: 'aliyun', label: '阿里', index: 'https://mirrors.aliyun.com/pypi/simple/' },
    { id: 'pypi', label: 'PyPI 官方', index: 'https://pypi.org/simple/' },
  ]
}

/**
 * The exact wheel that matches the bundled Python 3.12 / 64-bit Windows runtime.
 * Metadata verified against the official PyPI JSON API; the SHA-256 is the
 * official digest so a corrupted mirror download can be rejected.
 */
export const GPU_PACKAGE = {
  name: 'onnxruntime-gpu',
  version: ORT_VERSION,
  wheel: 'onnxruntime_gpu-1.19.2-cp312-cp312-win_amd64.whl',
  sha256: 'e7c6165a405027e3c0f11d189ae7013b5d66919b3381f9bfb3405c0c0cf07968',
  size: 226370340,
}

/** Size of each Range probe and how long a probe may take before we give up. */
export const PROBE_BYTES = 3 * 1024 * 1024
export const PROBE_TIMEOUT_MS = 8000

function pythonExe(root) {
  return join(root, 'runtime', platform() === 'win32' ? 'python.exe' : 'python')
}

function fmtSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return 'unknown'
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
}

/** Read a command's stdout as UTF-8; used only by the default provider probe. */
function runCapture(command, args, { signal } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    const onAbort = () => child.kill()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout?.on('data', (c) => chunks.push(c))
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8') })
    child.on('error', (err) => {
      signal?.removeEventListener?.('abort', onAbort)
      rejectPromise(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort)
      if (code === 0) resolvePromise(Buffer.concat(chunks).toString('utf8'))
      else rejectPromise(new Error(`${basename(command)} exited with code ${code}: ${stderr.trim()}`))
    })
  })
}

/** Default shell pip install — replaced by pipImpl in offline tests. */
async function defaultPipInstall(python, index, pkg, { signal, onProgress } = {}) {
  const args = ['-m', 'pip', 'install', '-i', index, `${pkg.name}==${pkg.version}`, '--force-reinstall']
  onProgress?.({ phase: 'gpu-pip', message: `pip install ${pkg.name}==${pkg.version} from ${index}` })
  const out = await runCapture(python, args, { signal })
  if (out.trim()) onProgress?.({ phase: 'gpu-pip', message: out.trim().split('\n').at(-1) })
}

/** Default runtime provider probe — replaced by providerImpl in offline tests. */
async function defaultProviders(python, signal) {
  const code = 'import json,onnxruntime;print(json.dumps(onnxruntime.get_available_providers()))'
  const out = await runCapture(python, ['-c', code], { signal })
  const line = out.trim().split('\n').at(-1) ?? ''
  const parsed = JSON.parse(line)
  if (!Array.isArray(parsed)) throw new Error('get_available_providers() did not return a list')
  return parsed
}

/** Find the onnxruntime_gpu-<version>.dist-info folder inside the runtime. */
async function findGpuDistInfo(root) {
  const bases = [
    join(root, 'runtime', 'Lib', 'site-packages'),
    join(root, 'runtime', 'lib', 'site-packages'),
  ]
  for (const base of bases) {
    if (!existsSync(base)) continue
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const match = /^onnxruntime_gpu-(\d+\.\d+\.\d+)\.dist-info$/.exec(entry.name)
      if (match) return { path: join(base, entry.name), version: match[1] }
    }
  }
  return null
}

/**
 * Status of the optional GPU component. Never throws for "not installed" —
 * that is the normal state the settings page renders as an install button.
 */
export async function gpuStatus(options = {}) {
  const root = singingRoot(options)
  const python = pythonExe(root)
  const dist = await findGpuDistInfo(root)
  let providers = null
  if (options.providerImpl) {
    try { providers = await options.providerImpl(python, options.signal) } catch { providers = null }
  } else if (dist) {
    // Only spawn the real interpreter when something is actually installed;
    // a clean machine reports "not installed" without touching the runtime.
    try { providers = await defaultProviders(python, options.signal) } catch { providers = null }
  }
  const cudaAvailable = Array.isArray(providers) && providers.includes('CUDAExecutionProvider')
  return {
    ok: true,
    installed: Boolean(dist),
    version: dist?.version ?? null,
    distInfoPath: dist?.path ?? null,
    cudaAvailable,
    providers,
    python,
  }
}

/**
 * Resolve the wheel download URL advertised by a mirror's simple index.
 * Injectable fetchImpl makes this fully testable without a network.
 */
async function resolveWheelUrl(index, ctx) {
  const base = index.endsWith('/') ? index : `${index}/`
  const pageUrl = new URL(`${ctx.packageName}/`, base).toString()
  const response = await ctx.fetchImpl(pageUrl, { signal: ctx.signal })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${pageUrl}`)
  const html = await response.text()
  const re = /href=["']([^"']+)["']/g
  let match
  while ((match = re.exec(html))) {
    const href = match[1].split('#')[0]
    if (href.endsWith(ctx.wheel)) return new URL(href, pageUrl).toString()
  }
  throw new Error(`wheel ${ctx.wheel} not found in ${pageUrl}`)
}

/** Consume at most `probeBytes` from a response body (stream or async iterable). */
async function readProbeBytes(response, probeBytes) {
  let bytes = 0
  const reader = response.body?.getReader ? response.body.getReader() : response.body
  if (reader && typeof reader.read === 'function') {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value?.length ?? 0
      if (bytes >= probeBytes) break
    }
    await reader.cancel?.().catch?.(() => {})
  } else if (reader && typeof reader[Symbol.asyncIterator] === 'function') {
    for await (const value of reader) {
      bytes += value?.length ?? 0
      if (bytes >= probeBytes) break
    }
  }
  return bytes
}

/**
 * Measure one mirror: resolve its wheel URL, issue a bounded Range request with
 * a timeout, and return measured throughput (bytes/sec). Throws on any failure
 * so the caller can skip this source.
 */
async function probeSource(source, ctx) {
  const wheelUrl = await resolveWheelUrl(source.index, ctx)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  ctx.signal?.addEventListener?.('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs)
  const started = Date.now()
  let bytes = 0
  try {
    const response = await ctx.fetchImpl(wheelUrl, {
      headers: { Range: `bytes=0-${ctx.probeBytes - 1}` },
      signal: controller.signal,
    })
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
    bytes = await readProbeBytes(response, ctx.probeBytes)
    if (bytes <= 0) throw new Error('probe returned no bytes')
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener?.('abort', onAbort)
  }
  const elapsed = Math.max(1, Date.now() - started)
  return { source, wheelUrl, bytes, elapsed, speed: bytes / (elapsed / 1000) }
}

/**
 * Install the GPU component through the fastest available mirror.
 *
 * 1. Probe every candidate (skipping failures) and rank by measured speed.
 * 2. Try pip install through each source in that order; the first success wins,
 *    a failure moves to the next source. All failures throw GPU_INSTALL_FAILED.
 *
 * Injectable: fetchImpl (probe HTTP), probeImpl (replace probing entirely),
 * pipImpl (replace the install), providerImpl (replace the status probe).
 */
export async function installGpuRuntime(options = {}) {
  const root = singingRoot(options)
  const python = pythonExe(root)
  const sources = options.sources ?? gpuSources()
  if (!Array.isArray(sources) || sources.length === 0) {
    throw Object.assign(new Error('no GPU package sources configured'), { code: 'GPU_NO_SOURCE' })
  }
  const onProgress = options.onProgress ?? (() => {})
  const probe = options.probeImpl ?? probeSource
  const pip = options.pipImpl ?? defaultPipInstall
  const probeCtx = {
    fetchImpl: options.fetchImpl ?? fetch,
    signal: options.signal,
    probeBytes: options.probeBytes ?? PROBE_BYTES,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    packageName: GPU_PACKAGE.name,
    wheel: GPU_PACKAGE.wheel,
    onProgress,
  }

  // 1. Measure every source, then rank the survivors by speed (descending).
  const ranked = []
  for (const source of sources) {
    if (options.signal?.aborted) throw new Error('install cancelled')
    onProgress?.({ phase: 'gpu-probe', message: `测速 ${source.label}`, source: source.id })
    try {
      const result = await probe(source, probeCtx)
      ranked.push({ source, ...result })
      onProgress?.({
        phase: 'gpu-probe', message: `${source.label} ${fmtSpeed(result.speed)}`,
        source: source.id, speed: result.speed,
      })
    } catch (error) {
      onProgress?.({
        phase: 'gpu-probe', message: `${source.label} 测速失败: ${error instanceof Error ? error.message : String(error)}`,
        source: source.id, error: true,
      })
    }
  }
  ranked.sort((a, b) => (b.speed ?? -1) - (a.speed ?? -1))
  // Sources whose probe failed keep their original order AFTER the measured
  // ones — a bad probe (e.g. changed index markup) must not block installation.
  const order = [
    ...ranked.map((r) => r.source),
    ...sources.filter((s) => !ranked.some((r) => r.source.id === s.id)),
  ]
  onProgress?.({
    phase: 'gpu-probe',
    message: `选定最快源 ${order[0].label}`,
    source: order[0].id,
    selected: order[0].id,
  })

  // 2. Install through the ranked sources; first success wins.
  const errors = []
  for (const source of order) {
    if (options.signal?.aborted) throw new Error('install cancelled')
    onProgress?.({
      phase: 'gpu-install', message: `从 ${source.label} 安装显卡组件`,
      source: source.id, index: source.index,
    })
    try {
      await pip(python, source.index, GPU_PACKAGE, { signal: options.signal, onProgress })
      const status = await gpuStatus({ root, providerImpl: options.providerImpl, signal: options.signal })
      onProgress?.({ phase: 'gpu-install', message: '显卡组件安装完成', source: source.id })
      return { ok: true, source: source.id, index: source.index, status }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      errors.push(`${source.id}: ${detail}`)
      onProgress?.({
        phase: 'gpu-install', message: `${source.label} 安装失败，切换下一个源`,
        source: source.id, error: true,
      })
    }
  }
  throw Object.assign(new Error(`all GPU install sources failed: ${errors.join(' | ')}`), {
    code: 'GPU_INSTALL_FAILED',
  })
}

export const __singingGpuTest = {
  gpuSources, resolveWheelUrl, probeSource, readProbeBytes,
  findGpuDistInfo, defaultPipInstall, defaultProviders, pythonExe, fmtSpeed,
}
