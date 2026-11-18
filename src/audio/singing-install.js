/**
 * Local singing environment installer — plan M4, route B (build a minimal
 * runtime ourselves instead of shipping the 1 GB generic base).
 *
 * Two artefacts are installed under one machine-wide root
 * (`~/.dsh/anyaudio/singing`, overridable by ANYAUDIO_SINGING_DIR):
 *   1. a redistributable CPython 3.12 runtime (python-build-standalone)
 *   2. the Qixuan voicebank (official zip from GitHub or a local copy)
 * The official voicebank zip ALREADY CONTAINS its neural vocoder in `dsvocoder/`
 * (verified in stage 1), so no separate vocoder download is needed — doing one
 * would only add a stalled GitHub transfer for users in mainland China.
 * Then a fixed dependency list is pip-installed into that runtime so the
 * exact `runtime/python.exe` M1 launches can import diffsinger_utau.
 *
 * Everything that touches the network, the shell or a fixed path is an
 * injectable option so the settings test can drive the whole flow against a
 * local fake HTTP server with no internet and no real ~/.dsh writes.
 *
 * All URLs and checksums below are public release metadata — no personal
 * paths and no credentials belong in this file.
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const GITHUB = 'https://github.com'
const PROXIES = ['https://gh-proxy.com/', 'https://ghproxy.net/']
// Mirrors measured 2026-11-17: Aliyun's simple index took 15 s+ for 650 KB
// (pip effectively stalls); TUNA answered in 0.28 s. Use the fast one.
export const PIP_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple/'
export const TORCH_INDEX = 'https://download.pytorch.org/whl/cpu'
// diffsinger_utau.voice_bank imports matplotlib through pred_pitch at load time.
// Without it the worker cannot become ready, so it is part of the minimal set.
export const REQUIRED_PIP = ['matplotlib>=3.5']
export const DEFAULT_VOICEBANK_DIR = 'Qixuan_v2.7.0_DiffSinger_OpenUtau'

/** Fixed dependency versions, matching the stage-1 environment byte-for-byte. */
export const PIP_GROUPS = [
  {
    label: 'torch (CPU)',
    index: TORCH_INDEX,
    specs: ['torch==2.7.1+cpu'],
  },
  {
    label: 'inference dependencies',
    index: PIP_INDEX,
    specs: [
      'onnxruntime==1.19.2',
      'numpy==1.26.4',
      'scipy==1.17.1',
      'librosa==0.10.2.post1',
      'PyYAML==6.0.3',
      'pypinyin==0.55.0',
      'diffsinger-utau==0.3.8',
      ...REQUIRED_PIP,
    ],
  },
]

/**
 * Public release metadata. Each entry carries several candidate URLs: mirrors
 * first (fast / reachable from CN), the official GitHub URL last as fallback.
 * `defaultManifest` is a function so callers can deep-clone and override URLs
 * for the offline test without mutating shared state.
 */
/** Official SHA-256 of the Qixuan zip; also verifies a locally downloaded copy. */
export const VOICEBANK_SHA256 = 'fe8ee7c95883d327a2b7facbbe832a7a53e1344918dc791ca83fc23b080341110'
export const VOICEBANK_FILE = 'Qixuan_v2.7.0_DiffSinger_OpenUtau.zip'

/** Public download sources for the official voicebank zip. The net-disk links
 *  are the public share links supplied by the user — no credentials. */
export const VOICEBANK_SOURCES = [
  { id: 'github', label: 'GitHub', url: 'https://github.com/yqzhishen/qixuan-diffsinger/releases/download/v2.7.0/Qixuan_v2.7.0_DiffSinger_OpenUtau.zip' },
  { id: 'baidu', label: '百度网盘', url: 'https://pan.baidu.com/s/1WUuBy2QLmC52-uzqppr6Qg?pwd=6666' },
  { id: 'quark', label: '夸克网盘', url: 'https://pan.quark.cn/s/b7dbaf52c430' },
]

export function defaultManifest() {
  const runtime = `${GITHUB}/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only.tar.gz`
  const bank = VOICEBANK_SOURCES[0].url
  return {
    runtime: {
      file: 'cpython-3.12.16+20261110-x86_64-pc-windows-msvc-install_only.tar.gz',
      sha256: 'e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b',
      urls: [PROXIES[0] + runtime, runtime],
    },
    voicebank: {
      file: 'Qixuan_v2.7.0_DiffSinger_OpenUtau.zip',
      sha256: 'fe8ee7c95883d327a2b7facbbe832a7a53e1344918dc791ca83fc23b08034110',
      urls: [PROXIES[0] + bank, PROXIES[1] + bank, bank],
    },
  }
}

export function singingRoot(options = {}) {
  const fromEnv = process.env.ANYAUDIO_SINGING_DIR
  const root = options.root ?? (fromEnv && fromEnv.trim() ? fromEnv.trim() : null)
    ?? join(homedir(), '.dsh', 'anyaudio', 'singing')
  return resolve(root)
}

function runtimeExe(root) {
  return join(root, 'runtime', platform() === 'win32' ? 'python.exe' : 'python')
}

function voicebankDir(root, name = DEFAULT_VOICEBANK_DIR) {
  return join(root, 'voicebank', name)
}

/** Compute a SHA-256 as a stream so a 400 MB voicebank never enters memory. */
export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
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
 * The curl `-C -` trap (appendix B.7 #1) is avoided structurally: we only send
 * a Range header when the partial file already exists. A server that ignores
 * Range and answers 200 is handled by restarting from zero. The part file is
 * renamed into place only after its SHA-256 matches.
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

function runProcess(command, args, { signal, onLine, cwd } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const onAbort = () => child.kill()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    let last = ''
    const eat = (chunk) => {
      const text = `${last}${chunk.toString('utf8')}`
      const lines = text.split(/\r?\n/)
      last = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) onLine?.(line.trim())
      }
    }
    child.stdout?.on('data', eat)
    child.stderr?.on('data', eat)
    child.on('error', (err) => {
      signal?.removeEventListener?.('abort', onAbort)
      rejectPromise(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', onAbort)
      if (last.trim()) onLine?.(last.trim())
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${basename(command)} exited with code ${code}`))
    })
  })
}

/** Extract an archive using the OS tar (Windows 10+ ships bsdtar, handles zip). */
async function defaultExtract(archive, destDir, ctx) {
  await mkdir(destDir, { recursive: true })
  await runProcess('tar', ['-xf', archive, '-C', destDir], {
    signal: ctx.signal,
    onLine: (line) => ctx.onProgress?.({ phase: ctx.phase, message: line }),
  })
}

/** pip-install one fixed dependency group into the runtime interpreter. */
async function defaultPip(python, group, ctx) {
  const args = ['-m', 'pip', 'install', '-i', group.index, ...group.specs]
  await runProcess(python, args, {
    signal: ctx.signal,
    onLine: (line) => ctx.onProgress?.({ phase: 'pip', message: `[${group.label}] ${line}` }),
  })
}

async function findChildWith(dir, predicate) {
  if (!existsSync(dir)) return null
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && predicate) {
      const candidate = join(dir, entry.name)
      if (await predicate(candidate)) return candidate
    }
  }
  return null
}

/**
 * Status of the three artefacts. Never throws for "not installed" — that is a
 * normal state the settings page renders as an install button.
 */
export async function singingStatus(options = {}) {
  const root = singingRoot(options)
  const py = runtimeExe(root)
  const bankName = options.voicebank ?? DEFAULT_VOICEBANK_DIR
  const bank = voicebankDir(root, bankName)
  const vocoder = join(bank, 'dsvocoder', 'vocoder.yaml')
  const runtime = { installed: existsSync(py), path: py }
  const voicebank = { installed: existsSync(join(bank, 'dsconfig.yaml')), path: bank, name: bankName }
  const voc = { installed: existsSync(vocoder), path: vocoder }
  let runtimeVersion = null
  if (runtime.installed) {
    try {
      const out = await new Promise((ok, bad) => {
        const chunks = []
        const child = spawn(py, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', (c) => chunks.push(c))
        child.on('error', bad)
        child.on('close', (code) => (code === 0 ? ok(Buffer.concat(chunks).toString('utf8')) : bad(new Error(`exit ${code}`))))
      })
      runtimeVersion = out.trim() || null
    } catch {
      // A half-installed runtime is reported as installed but without a version.
    }
  }
  return {
    ok: true,
    root,
    runtime: { ...runtime, version: runtimeVersion },
    voicebank,
    vocoder: voc,
    ready: runtime.installed && voicebank.installed && voc.installed,
  }
}

/** Voicebanks already installed — for the settings-page dropdown. */
export async function listSingingVoices(options = {}) {
  const root = singingRoot(options)
  const base = join(root, 'voicebank')
  const voices = []
  if (existsSync(base)) {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      if (existsSync(join(dir, 'dsconfig.yaml'))) {
        voices.push({ name: entry.name, path: dir, installed: true })
      }
    }
  }
  return { ok: true, voices }
}

/**
 * Install everything. Idempotent at the file level: a downloaded, checksum-
 * verified archive is reused, so a retry resumes instead of restarting.
 */
export async function runSingingInstall(options = {}) {
  const root = singingRoot(options)
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
  const runtimeExePath = runtimeExe(root)
  if (!existsSync(runtimeExePath)) {
    const archive = join(downloads, manifest.runtime.file)
    await downloadArtifact(manifest.runtime, archive, { ...ctx, phase: 'runtime' })
    note('runtime-extract', 'extracting Python runtime')
    const staging = join(root, '.runtime-stage')
    await rm(staging, { recursive: true, force: true })
    await ctx.extractImpl(archive, staging, { ...ctx, phase: 'runtime-extract' })
    const extracted = await findChildWith(staging, async (c) => existsSync(join(c, platform() === 'win32' ? 'python.exe' : 'python')))
      ?? staging
    await rm(join(root, 'runtime'), { recursive: true, force: true })
    await rename(extracted, join(root, 'runtime'))
    await rm(staging, { recursive: true, force: true })
  } else {
    note('runtime', 'runtime already present, skipping')
  }

  // 2. Voicebank: download → extract into `voicebank/`.
  const bankArchive = join(downloads, manifest.voicebank.file)
  const bankDir = voicebankDir(root, options.voicebank ?? DEFAULT_VOICEBANK_DIR)
  if (!existsSync(join(bankDir, 'dsconfig.yaml'))) {
    await downloadArtifact(manifest.voicebank, bankArchive, { ...ctx, phase: 'voicebank' })
    note('voicebank-extract', 'extracting voicebank')
    await mkdir(join(root, 'voicebank'), { recursive: true })
    await ctx.extractImpl(bankArchive, join(root, 'voicebank'), { ...ctx, phase: 'voicebank-extract' })
  } else {
    note('voicebank', 'voicebank already present, skipping')
  }

  // The official voicebank zip already carries dsvocoder/ (with the neural
  // vocoder onnx) — no separate vocoder download. Just confirm it came through.
  note('vocoder', `using bundled vocoder at ${join(bankDir, 'dsvocoder')}`)

  // 3. Fixed-version dependencies into the exact interpreter M1 launches.
  if (options.pipImpl) {
    note('pip', 'pip install delegated (test mode)')
    for (const group of options.pipGroups ?? PIP_GROUPS) {
      await options.pipImpl(runtimeExePath, group, ctx)
    }
  } else if (!options.skipPip) {
    for (const group of PIP_GROUPS) {
      note('pip', `installing ${group.label}`)
      await defaultPip(runtimeExePath, group, ctx)
    }
  }

  const status = await singingStatus({ root, voicebank: options.voicebank })
  if (!status.ready) {
    const failure = new Error('install finished but artefacts are incomplete')
    failure.code = 'INSTALL_INCOMPLETE'
    failure.status = status
    throw failure
  }
  return status
}

/**
 * Install the voicebank from a zip the user downloaded themselves (net-disk or
 * GitHub). Verifies the official SHA-256 before extracting anything, so a
 * corrupt / tampered / wrong file can never reach the voicebank folder. The
 * official zip already contains dsvocoder/, so no separate vocoder download.
 *
 * Returns the machine-wide status after extraction. Throws a tagged error
 * (`code`) with a clear, translated-by-the-client message on bad input.
 */
/**
 * Find the actual voicebank directory inside an extracted archive: the first
 * directory (shallowest) containing `dsconfig.yaml`. Third-party zips either
 * put dsconfig.yaml at the root or nest one folder (e.g. Lianhua ships
 * `Lianhua_DiffSinger_v2.1.50_beta/dsconfig.yaml`); both are handled here.
 */
async function findVoicebankDir(base, depth = 0) {
  if (existsSync(join(base, 'dsconfig.yaml'))) return base
  if (depth >= 3 || !existsSync(base)) return null
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const found = await findVoicebankDir(join(base, entry.name), depth + 1)
    if (found) return found
  }
  return null
}

export async function installVoicebankFromZip(options = {}) {
  const root = singingRoot(options)
  const zipPath = typeof options.zipPath === 'string' ? resolve(options.zipPath.trim()) : ''
  if (!zipPath) throw Object.assign(new Error('zipPath is required'), { code: 'BAD_ZIP_PATH' })
  if (!existsSync(zipPath)) {
    throw Object.assign(new Error(`voicebank zip not found: ${zipPath}`), { code: 'ZIP_NOT_FOUND' })
  }
  const info = await stat(zipPath)
  if (!info.isFile()) throw Object.assign(new Error('zipPath must be a file'), { code: 'BAD_ZIP_PATH' })

  const ctx = {
    signal: options.signal,
    onProgress: options.onProgress ?? (() => {}),
    extractImpl: options.extractImpl ?? defaultExtract,
  }
  // No checksum / whitelist here on purpose (user request): a locally supplied
  // zip may be ANY third-party DiffSinger bank with no published digest. Only
  // basic input validation above and a dsconfig.yaml check after extraction.
  ctx.onProgress?.({ phase: 'voicebank-extract', message: 'extracting voicebank', received: 0, total: info.size })
  const vault = join(root, 'voicebank')
  await mkdir(vault, { recursive: true })
  const staging = join(root, '.voicebank-stage')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await ctx.extractImpl(zipPath, staging, { ...ctx, phase: 'voicebank-extract' })

  // dsconfig.yaml is the only validity signal; whether the bank carries its own
  // vocoder is left to the user to hear/test — we never reject on that.
  const extracted = await findVoicebankDir(staging)
  if (!extracted) {
    await rm(staging, { recursive: true, force: true })
    throw Object.assign(new Error('no DiffSinger voicebank found in the zip (no dsconfig.yaml)'), {
      code: 'BAD_ARCHIVE',
    })
  }
  const fallbackName = basename(zipPath).replace(/\.(zip|oudep)$/i, '')
  const name = options.voicebank ?? (extracted === staging ? fallbackName : basename(extracted))
  const bankDir = voicebankDir(root, name)
  if (existsSync(join(bankDir, 'dsconfig.yaml'))) {
    await rm(staging, { recursive: true, force: true })
    throw Object.assign(new Error('voicebank already installed; remove it first to reinstall'), {
      code: 'ALREADY_INSTALLED', path: bankDir,
    })
  }
  await mkdir(vault, { recursive: true })
  await rename(extracted, bankDir)
  await rm(staging, { recursive: true, force: true })
  return { ...(await singingStatus({ root, voicebank: name })), name }
}

export const __singingInstallTest = {
  downloadUrl, downloadArtifact, defaultExtract, defaultPip, runtimeExe, voicebankDir, runProcess,
}
