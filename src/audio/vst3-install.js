/**
 * Local VST3 render-runtime installer.
 *
 * The VST3 sidecar (engine/vst3_worker.py) needs a Python that can import
 * pedalboard, numpy and mido. A developer checkout has `<repo>/.venv`, but a
 * person who only installed the plugin has no such environment, so this module
 * installs a redistributable CPython 3.12 under one machine-wide root
 * (`~/.dsh/anyaudio/vst3`, overridable by ANYAUDIO_VST3_DIR) plus the three
 * dependencies, so `runtime/python.exe` is what vst3-process.js launches.
 *
 * Same shape as singing-install.js, minus the vocoder and the voicebank: one
 * runtime artifact, one pip group, one verification. Everything that touches
 * the network, the shell or a fixed path is an injectable option so a test can
 * drive the whole flow offline with no internet and no real ~/.dsh writes.
 *
 * All URLs and checksums below are public release metadata — no personal paths
 * and no credentials belong in this file.
 */
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { sha256File } from './fonts.js'
import { defaultManifest as singingManifest } from './singing-install.js'

const GITHUB = 'https://github.com'
const PROXIES = ['https://gh-proxy.com/', 'https://ghproxy.net/']
// Mirrors measured 2026-11-17: Aliyun's simple index took 15 s+ for 650 KB
// (pip effectively stalls); TUNA answered in 0.28 s. Use the fast one.
export const PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple/'
/** What the sidecar imports at startup; nothing else is installed. */
export const VST3_PIP_SPECS = ['pedalboard', 'numpy', 'mido']
export const VST3_PIP_GROUP = { label: 'VST3 render dependencies', index: PIP_INDEX, specs: VST3_PIP_SPECS }

/**
 * Public release metadata. The CPython build is the same artifact the singing
 * runtime uses, so its file name and SHA-256 are taken from that manifest
 * instead of being copied here (one checksum, one place to bump). Only the
 * mirror list differs: VST3 tries both gh-proxy hosts before GitHub itself.
 */
export function defaultManifest() {
  const runtime = singingManifest().runtime
  const official = runtime.urls[runtime.urls.length - 1]
  return {
    runtime: {
      file: runtime.file,
      sha256: runtime.sha256,
      urls: [PROXIES[0] + official, PROXIES[1] + official, official],
    },
  }
}

/** Machine-wide VST3 root: the runtime and its downloads live under it. */
export function vst3Root(options = {}) {
  const fromEnv = process.env.ANYAUDIO_VST3_DIR
  const root = options.root ?? (fromEnv && fromEnv.trim() ? fromEnv.trim() : null)
    ?? join(homedir(), '.dsh', 'anyaudio', 'vst3')
  return resolve(root)
}

/** The interpreter the sidecar launches once the runtime is installed. */
export function vst3RuntimeExe(root) {
  return join(root, 'runtime', platform() === 'win32' ? 'python.exe' : 'python')
}

async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * Download one URL into `<dest>.part`, resuming when a partial file exists.
 *
 * A Range header is only sent when the partial file already exists, so a server
 * that ignores Range and answers 200 is handled by restarting from zero. The
 * part file is renamed into place only after its SHA-256 matches.
 */
async function downloadUrl(url, dest, { fetchImpl, signal, sha256, onProgress, label }) {
  const part = `${dest}.part`
  let start = await fileSize(part)
  const headers = start > 0 ? { Range: `bytes=${start}-` } : {}
  const doFetch = fetchImpl ?? fetch
  const response = await doFetch(url, { headers, signal })
  try {
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`)
    }
    let append = false
    if (response.status === 206 && start > 0) {
      append = true
    } else {
      // Server restarted the body (200) or our Range was invalid: start fresh.
      start = 0
      append = false
    }
    const contentRange = response.headers?.get?.('content-range') ?? null
    const totalHeader = response.headers?.get?.('content-length') ?? null
    let total = Number(totalHeader ?? 0) || 0
    let fullFromRange = false
    if (contentRange && contentRange.includes('/')) {
      const all = Number(contentRange.split('/').pop())
      if (Number.isFinite(all) && all > 0) {
        total = all // content-range's `/total` is the FULL size, not the remainder.
        fullFromRange = true
      }
    }
    // A 206 without a usable content-range only reports the remaining bytes.
    if (append && !fullFromRange) total += start
    let received = start

    await mkdir(dirname(dest), { recursive: true }).catch(() => {})
    const out = createWriteStream(part, { flags: append ? 'a' : 'w' })
    const reader = response.body?.getReader
      ? response.body.getReader()
      : response.body
    if (reader && typeof reader.read === 'function') {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal?.aborted) throw new Error('download cancelled')
        const buf = Buffer.from(value)
        if (!out.write(buf)) {
          await new Promise((ok, bad) => {
            out.once('drain', ok)
            out.once('error', bad)
          })
        }
        received += buf.length
        onProgress?.({ received, total, url, label })
      }
    } else if (reader && typeof reader[Symbol.asyncIterator] === 'function') {
      for await (const value of reader) {
        if (signal?.aborted) throw new Error('download cancelled')
        const buf = Buffer.from(value)
        out.write(buf)
        received += buf.length
        onProgress?.({ received, total, url, label })
      }
    }
    await new Promise((ok, bad) => out.end((err) => (err ? bad(err) : ok())))

    const digest = await sha256File(part)
    if (sha256 && digest !== sha256) {
      await rm(part, { force: true })
      throw new Error(`SHA-256 mismatch for ${label}: expected ${sha256}, got ${digest}`)
    }
    await rename(part, dest)
    return { received, sha256: digest, url }
  } finally {
    response.body?.cancel?.().catch?.(() => {})
  }
}

/** Try every candidate URL in order; only the last failure is reported. */
async function downloadArtifact(spec, dest, ctx) {
  const errors = []
  for (const url of spec.urls) {
    ctx.onProgress?.({ phase: `${ctx.phase}-download`, message: `downloading ${spec.file} from ${urlLabel(url)}`, url })
    try {
      const info = await downloadUrl(url, dest, {
        fetchImpl: ctx.fetchImpl, signal: ctx.signal, sha256: spec.sha256,
        label: spec.file,
        onProgress: (p) => ctx.onProgress?.({ ...p, phase: `${ctx.phase}-download` }),
      })
      return { ...info, path: dest }
    } catch (error) {
      errors.push(`${urlLabel(url)}: ${error instanceof Error ? error.message : String(error)}`)
      ctx.onProgress?.({ phase: `${ctx.phase}-download`, message: `mirror failed, trying next: ${errors.at(-1)}` })
    }
  }
  const failure = new Error(`all sources failed for ${spec.file}: ${errors.join(' | ')}`)
  failure.code = 'DOWNLOAD_FAILED'
  throw failure
}

function urlLabel(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url)
  }
}

/**
 * Run a command with its output redirected to temp files instead of pipes: the
 * DSH sandbox forbids capturing a child's output through them, and a bare spawn
 * failure would otherwise surface as only "exited with code 1". Returns the exit
 * code and the captured text; a non-zero exit is the caller's decision.
 */
async function runProcess(command, args, { signal, onLine, cwd } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'anyaudio-vst3-proc-'))
  const outPath = join(scratch, 'stdout')
  const errPath = join(scratch, 'stderr')
  const out = await open(outPath, 'w')
  const err = await open(errPath, 'w')
  try {
    const code = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { windowsHide: true, cwd, stdio: ['ignore', out.fd, err.fd] })
      const onAbort = () => child.kill()
      signal?.addEventListener?.('abort', onAbort, { once: true })
      const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
      child.on('error', (error) => {
        cleanup()
        rejectPromise(error)
      })
      child.on('close', (exitCode) => {
        cleanup()
        resolvePromise(exitCode ?? 1)
      })
    })
    let stdout = ''
    let stderr = ''
    try { stdout = readFileSync(outPath, 'utf8') } catch {}
    try { stderr = readFileSync(errPath, 'utf8') } catch {}
    for (const line of `${stdout}${stderr}`.split(/\r?\n/)) {
      if (line.trim()) onLine?.(line.trim())
    }
    return { code, stdout, stderr }
  } finally {
    await out.close().catch(() => {})
    await err.close().catch(() => {})
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Extract an archive using the OS tar (Windows 10+ ships bsdtar, handles zip). */
async function defaultExtract(archive, destDir, ctx) {
  await mkdir(destDir, { recursive: true })
  const { code, stdout, stderr } = await runProcess('tar', ['-xf', archive, '-C', destDir], {
    signal: ctx.signal,
    onLine: (line) => ctx.onProgress?.({ phase: ctx.phase, message: line }),
  })
  if (code !== 0) {
    const detail = `${stdout}${stderr}`.trim()
    const failure = new Error(`tar exited with code ${code}${detail ? `: ${detail}` : ''}`)
    failure.code = 'EXTRACT_FAILED'
    throw failure
  }
}

/** pip-install the fixed dependency group into the runtime interpreter. */
async function defaultPip(python, group, ctx) {
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '-i', group.index, ...group.specs]
  const { code, stdout, stderr } = await runProcess(python, args, {
    signal: ctx.signal,
    onLine: (line) => ctx.onProgress?.({ phase: 'pip', message: `[${group.label}] ${line}` }),
  })
  if (code !== 0) {
    const detail = `${stdout}${stderr}`.trim().split(/\r?\n/).slice(-6).join('\n')
    const failure = new Error(`pip install failed (exit ${code})${detail ? `: ${detail}` : ''}`)
    failure.code = 'PIP_FAILED'
    throw failure
  }
}

/**
 * Probe a runtime interpreter: its version and whether each dependency imports.
 * One process per question, and a failure is a value, never a throw — "not
 * installed yet" is a normal state the settings page renders as a button.
 */
async function defaultProbe(python, ctx) {
  const versionRun = await runProcess(python, ['--version'], { signal: ctx.signal }).catch(() => null)
  const version = versionRun && versionRun.code === 0
    ? `${versionRun.stdout}${versionRun.stderr}`.trim().split(/\r?\n/)[0] || null
    : null
  const script = [
    'import json',
    'out = {}',
    'for name in ("pedalboard", "numpy", "mido"):',
    '    try:',
    '        __import__(name)',
    '        out[name] = True',
    '    except Exception:',
    '        out[name] = False',
    'print(json.dumps(out))',
  ].join('\n')
  const depsRun = await runProcess(python, ['-c', script], { signal: ctx.signal }).catch(() => null)
  const deps = { pedalboard: false, numpy: false, mido: false }
  if (depsRun && depsRun.code === 0) {
    try {
      const parsed = JSON.parse(depsRun.stdout.trim().split(/\r?\n/).pop() ?? '{}')
      for (const name of Object.keys(deps)) deps[name] = parsed[name] === true
    } catch {
      // A runtime that cannot answer is reported as "deps missing", not as an error.
    }
  }
  return { version, deps }
}

async function findChildWith(dir, predicate) {
  if (!existsSync(dir)) return null
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(dir, entry.name)
    if (await predicate(candidate)) return candidate
  }
  return null
}

/**
 * Status of the VST3 render runtime. Never throws for "not installed" — that is
 * a normal state the settings page renders as an install button.
 */
export async function vst3Status(options = {}) {
  const root = vst3Root(options)
  const python = vst3RuntimeExe(root)
  const installed = existsSync(python)
  const probe = options.probeImpl ?? defaultProbe
  const probed = installed
    ? await probe(python, { signal: options.signal }).catch(() => ({ version: null, deps: {} }))
    : { version: null, deps: {} }
  const deps = {
    pedalboard: probed?.deps?.pedalboard === true,
    numpy: probed?.deps?.numpy === true,
    mido: probed?.deps?.mido === true,
  }
  return {
    ok: true,
    root,
    runtime: { installed, python, version: probed?.version ?? null },
    deps,
    ready: installed && deps.pedalboard && deps.numpy && deps.mido,
  }
}

/**
 * Install the VST3 render runtime: the CPython build, then the three
 * dependencies into that exact interpreter, then verify they import. Idempotent
 * at the file level: an existing runtime is reused, and a verified archive is
 * not downloaded twice.
 */
export async function runVst3Install(options = {}) {
  const root = vst3Root(options)
  const manifest = options.manifest ?? defaultManifest()
  const downloads = join(root, 'downloads')
  const ctx = {
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress ?? (() => {}),
    extractImpl: options.extractImpl ?? defaultExtract,
    pipImpl: options.pipImpl ?? defaultPip,
  }
  await mkdir(downloads, { recursive: true })
  const note = (phase, message) => ctx.onProgress?.({ phase, message })

  // 1. Runtime: download → extract → promote `<staging>/python` to `runtime/`.
  const python = vst3RuntimeExe(root)
  if (!existsSync(python)) {
    const archive = join(downloads, manifest.runtime.file)
    await downloadArtifact(manifest.runtime, archive, { ...ctx, phase: 'runtime' })
    note('runtime-extract', 'extracting Python runtime')
    const staging = join(root, '.runtime-stage')
    await rm(staging, { recursive: true, force: true })
    await ctx.extractImpl(archive, staging, { ...ctx, phase: 'runtime-extract' })
    const exeName = platform() === 'win32' ? 'python.exe' : 'python'
    const extracted = await findChildWith(staging, async (candidate) => existsSync(join(candidate, exeName)))
      ?? staging
    await rm(join(root, 'runtime'), { recursive: true, force: true })
    await rename(extracted, join(root, 'runtime'))
    await rm(staging, { recursive: true, force: true })
  } else {
    note('runtime', 'runtime already present, skipping')
  }

  // 2. Dependencies into the exact interpreter the sidecar launches.
  note('pip', `installing ${VST3_PIP_GROUP.specs.join(' ')}`)
  await ctx.pipImpl(python, VST3_PIP_GROUP, ctx)

  // 3. Verify: the sidecar is useless unless all three import.
  const status = await vst3Status({ root, signal: options.signal, ...(options.probeImpl ? { probeImpl: options.probeImpl } : {}) })
  if (!status.ready) {
    const missing = Object.entries(status.deps).filter(([, ok]) => !ok).map(([name]) => name)
    const failure = new Error(
      `install finished but the runtime cannot import ${missing.join(', ') || 'its dependencies'}`
      + ` (${status.runtime.python})`,
    )
    failure.code = 'INSTALL_INCOMPLETE'
    failure.status = status
    throw failure
  }
  return status
}

export const __vst3InstallTest = {
  downloadUrl, downloadArtifact, defaultExtract, defaultPip, defaultProbe, runProcess, findChildWith,
}
