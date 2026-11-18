// Node-side lifecycle manager for the local singing worker (engine/worker.py).
//
// Protocol — one JSON line in / one JSON line out over pipes (no network port):
//   worker -> us  {"type":"ready","device":...,"sampleRate":...}      (once, after load)
//   worker -> us  {"type":"result","id":N,"ok":true,...result fields}
//   worker -> us  {"type":"result","id":N,"ok":false,"kind":"param|infer","error":"..."}
//   worker -> us  {"type":"fatal","error":"..."}                      (load failure)
//   us -> worker  {"op":"sing","id":N,"notes":[...],"out":"...",...}
//   us -> worker  {"op":"shutdown"}
//
// Hard rules (plan M1 + scheme appendix B.7):
//  - Start on demand, exit after idleSec (60s default) with nothing pending.
//  - Write request lines as UTF-8 BYTES to stdin (Buffer.from, no BOM); text-mode
//    or PowerShell encoding corrupts Chinese lyrics / produces JSON parse errors.
//  - stderr is INHERITED, never piped: an unread pipe fills up and deadlocks the worker.
//  - One process at a time, bound to one device. A device/voicebank change recycles
//    the process so GPU-then-CPU can never share one (the worker globally patches
//    the inference entrypoint; a second patch would wrap the first).
//  - A venv python.exe is only a launcher; we judge liveness by stdout/child events
//    and kill the whole process tree on shutdown so the real interpreter cannot
//    survive as an orphan.
//  - First-inference warmup (GPU CUDA session) is done inside worker.py at load;
//    ensureReady() lets M2 absorb that cost before the first user-visible line.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_IDLE_SEC = 60
export const DEFAULT_VOICEBANK = 'Qixuan_v2.7.0_DiffSinger_OpenUtau'

const READY_TIMEOUT_MS = 120000 // cold start ~8s, GPU warmup a few seconds more
const SING_TIMEOUT_MS = 600000 // a 3-minute song takes ~4 min on CPU
const STDIO = ['pipe', 'pipe', 'inherit'] // index 2 = stderr inherited, NEVER 'pipe'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKER = resolve(here, '..', '..', 'engine', 'worker.py')

export class SingingProcessError extends Error {
  constructor(message, { code = 'SINGING_ERROR', kind = 'infer' } = {}) {
    super(message)
    this.name = 'SingingProcessError'
    this.code = code
    this.kind = kind
  }
}

function envPath(name) {
  const value = process.env[name]
  return value && value.trim() ? resolve(value.trim()) : null
}

/** Resolve the launch config. M2 passes only `device` / `voicebank`; runtime paths
 *  default to the machine-level singing dir and can be redirected by env for tests.
 *  Passing `command` or `args` marks an injected worker (test mode): path checks
 *  for the real python/voicebank/worker are skipped. */
export function resolveSingingConfig(options = {}) {
  const injected = Boolean(options.command || options.args)
  const root = envPath('ANYAUDIO_SINGING_DIR') ?? join(homedir(), '.dsh', 'anyaudio', 'singing')
  const requestedBank = options.voicebank
    ?? (process.env.ANYAUDIO_SINGING_VOICEBANK || DEFAULT_VOICEBANK)
  // Settings/config store a bare voicebank NAME, not a path. Resolve a bare name
  // against the machine-level voicebank dir; leave absolute/custom paths intact.
  const bareName = !isAbsolute(requestedBank) && !requestedBank.includes('/') && !requestedBank.includes('\\')
  const voicebank = bareName ? join(root, 'voicebank', requestedBank) : resolve(requestedBank)
  const worker = options.worker ?? envPath('ANYAUDIO_SINGING_WORKER') ?? DEFAULT_WORKER
  const python = options.python ?? envPath('ANYAUDIO_SINGING_PYTHON')
    ?? join(root, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python')
  const device = ['auto', 'cpu', 'cuda'].includes(options.device) ? options.device : 'auto'
  const idleSec = Number.isFinite(Number(options.idleSec)) ? Number(options.idleSec) : DEFAULT_IDLE_SEC
  const idleMs = Math.max(100, Number.isFinite(Number(options.idleMs)) ? Number(options.idleMs) : idleSec * 1000)

  const command = options.command ?? python
  const args = options.args ?? ['-X', 'utf8', worker, voicebank, device]

  return {
    command, args, worker, python, voicebank, device, root, idleMs, injected,
    readyTimeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
    singTimeoutMs: options.singTimeoutMs ?? SING_TIMEOUT_MS,
  }
}

function validateConfig(config) {
  if (config.injected) return
  const looksLikePath = isAbsolute(config.command) || config.command.includes('/') || config.command.includes('\\')
  if (looksLikePath && !existsSync(config.command)) {
    throw new SingingProcessError(
      `Singing runtime not found: ${config.command}. Install the singing engine first (Settings → AnyAudio → Singing).`,
      { code: 'ENV_MISSING' },
    )
  }
  if (!existsSync(config.voicebank) || !statSync(config.voicebank).isDirectory()) {
    throw new SingingProcessError(
      `Voicebank not found: ${config.voicebank}. Install a voicebank in Settings → AnyAudio → Singing first.`,
      { code: 'VOICEBANK_MISSING' },
    )
  }
  if (!existsSync(config.worker)) {
    throw new SingingProcessError(`Singing worker script not found: ${config.worker}`, { code: 'WORKER_MISSING' })
  }
}

export function createSingingProcess(options = {}) {
  return new SingingProcess(options)
}

class SingingProcess {
  constructor(options) {
    this.base = options
    this.child = null
    this.key = null
    this.config = null
    this.ready = null
    this.buffer = ''
    this.seq = 0
    this.pending = new Map()
    this.idleTimer = null
    this.queue = Promise.resolve()
    this.stats = { starts: 0, recycles: 0, lastDevice: null }
  }

  _configFor(call = {}) {
    return resolveSingingConfig({
      ...this.base,
      ...(call.device !== undefined ? { device: call.device } : {}),
      ...(call.voicebank !== undefined ? { voicebank: call.voicebank } : {}),
    })
  }

  static _keyOf(config) {
    // Include device/voicebank even though real args already contain them: an
    // injected test worker has fixed args but must still recycle on device change.
    return JSON.stringify([config.command, config.args, config.device, config.voicebank])
  }

  // Serialise every operation: two concurrent sing() calls must never start two
  // processes or race on the same stdin.
  _enqueue(fn) {
    const result = this.queue.then(fn, fn)
    this.queue = result.catch(() => {})
    return result
  }

  /** Public API used by M2. `task` is forwarded verbatim to the worker.
   *  Returns the result object (without the protocol envelope).
   *  `call` = { device, voicebank } for per-call overrides. */
  sing(task, call = {}) {
    return this._enqueue(async () => {
      const config = this._configFor(call)
      if (!task || !Array.isArray(task.notes) || task.notes.length === 0) {
        throw new SingingProcessError(
          'notes must be a non-empty array of [startSec, durSec, midi|null, lyric]',
          { code: 'BAD_NOTES', kind: 'param' },
        )
      }
      if (!task.out || typeof task.out !== 'string') {
        throw new SingingProcessError('out must be a WAV output path', { code: 'BAD_OUTPUT', kind: 'param' })
      }
      const key = SingingProcess._keyOf(config)
      if (this.key && this.key !== key) {
        await this._stopNow()
        this.stats.recycles += 1
      }
      if (!this.child) await this._start(config)
      this._cancelIdle()

      const id = ++this.seq
      const payload = { op: 'sing', id, ...task }
      const waited = this._waitFor(id, config.singTimeoutMs)
      // Direct UTF-8 bytes, no BOM — this is what keeps Chinese lyrics intact.
      this.child.stdin.write(Buffer.from(JSON.stringify(payload) + '\n', 'utf8'))
      let result
      try {
        result = await waited
      } finally {
        this._armIdle(config.idleMs)
      }
      return result
    })
  }

  /** Absorb startup + warmup cost before the first user-visible task (optional). */
  ensureReady(call = {}) {
    return this._enqueue(async () => {
      const config = this._configFor(call)
      const key = SingingProcess._keyOf(config)
      if (this.key && this.key !== key) {
        await this._stopNow()
        this.stats.recycles += 1
      }
      if (!this.child) await this._start(config)
      this._armIdle(config.idleMs)
      return { ...this.ready }
    })
  }

  _waitFor(id, timeoutMs) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SingingProcessError(
          `Singing synthesis timed out after ${Math.round(timeoutMs / 1000)}s (id=${id}).`,
          { code: 'SING_TIMEOUT' },
        ))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
  }

  _start(config) {
    return new Promise((resolveStart, rejectStart) => {
      try {
        validateConfig(config)
      } catch (err) {
        rejectStart(err)
        return
      }

      let child
      try {
        child = spawn(config.command, config.args, { stdio: STDIO, windowsHide: true })
      } catch (err) {
        rejectStart(new SingingProcessError(`Cannot spawn singing worker: ${err.message}`, { code: 'SPAWN_FAILED' }))
        return
      }
      this.child = child
      this.config = config
      this.key = SingingProcess._keyOf(config)
      this.buffer = ''
      this.ready = null

      let settled = false
      const settleReady = (info) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ready = info
        this.stats.starts += 1
        this.stats.lastDevice = info?.device ?? config.device
        resolveStart(info)
      }
      const settleFail = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectStart(err)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settleFail(new SingingProcessError(
          `Singing worker did not become ready within ${Math.round(config.readyTimeoutMs / 1000)}s. ` +
          'Check that the runtime and voicebank are installed correctly.',
          { code: 'START_TIMEOUT' },
        ))
        this._kill(child)
      }, config.readyTimeoutMs)
      timer.unref?.()
      this._settleReady = { settleReady, settleFail, settled: () => settled }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk
        let idx
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 1)
          if (line.trim()) this._onLine(line)
        }
      })
      child.stdin.on('error', (err) => this._failAll(err))
      child.on('error', (err) => {
        const wrapped = new SingingProcessError(
          `Cannot start singing worker (${config.command}): ${err.message}. ` +
          'Install the singing runtime or set ANYAUDIO_SINGING_PYTHON.',
          { code: 'SPAWN_FAILED' },
        )
        this._failAll(wrapped)
        settleFail(wrapped)
      })
      child.on('exit', () => {
        if (this.child === child) {
          this.child = null
          this.key = null
          this.config = null
          this.ready = null
          this._settleReady = null
        }
        if (!settled) {
          settleFail(new SingingProcessError('Singing worker exited before it was ready.', { code: 'WORKER_EXITED' }))
        } else {
          this._failAll(new SingingProcessError('Singing worker exited unexpectedly.', { code: 'WORKER_EXITED' }))
        }
      })
    })
  }

  _onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return // ignore non-protocol output on stdout
    }
    if (msg.type === 'ready') {
      this._settleReady?.settleReady(msg)
      return
    }
    if (msg.type === 'fatal') {
      const err = new SingingProcessError(msg.error || 'Singing worker fatal error', {
        code: 'WORKER_FATAL', kind: 'infer',
      })
      this._settleReady?.settleFail(err)
      this._failAll(err)
      this._kill(this.child)
      return
    }
    if (msg.type === 'result') {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.ok) {
        const { type, id, ok, ...result } = msg
        waiter.resolve(result)
      } else {
        waiter.reject(new SingingProcessError(msg.error || 'Singing synthesis failed', {
          code: msg.kind === 'param' ? 'BAD_REQUEST' : 'INFER_FAILED',
          kind: msg.kind === 'param' ? 'param' : 'infer',
        }))
      }
    }
  }

  _failAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  _kill(child) {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      // venv python.exe is a launcher; kill the whole tree so the real
      // interpreter does not survive as an orphan.
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        })
        killer.on('error', () => { try { child.kill('SIGKILL') } catch {} })
        return
      } catch {
        // fall through
      }
    }
    try { child.kill('SIGKILL') } catch {}
  }

  _cancelIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  _armIdle(idleMs) {
    this._cancelIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.stop().catch(() => {})
    }, idleMs)
    this.idleTimer.unref?.()
  }

  _stopNow() {
    this._cancelIdle()
    const child = this.child
    this.child = null
    this.key = null
    this.config = null
    this.ready = null
    this.buffer = ''
    this._settleReady = null
    this._failAll(new SingingProcessError('Singing worker stopped.', { code: 'STOPPED' }))
    if (!child) return Promise.resolve()
    return new Promise((resolveStop) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolveStop() } }
      child.once('exit', finish)
      this._kill(child)
      setTimeout(finish, 3000).unref?.()
    })
  }

  /** Explicitly stop the worker (idempotent). */
  stop() {
    return this._enqueue(() => this._stopNow())
  }

  /** Diagnostics for tests / M2 — never exposes the child or its pipes. */
  getState() {
    return {
      running: Boolean(this.child),
      device: this.ready?.device ?? this.config?.device ?? null,
      voicebank: this.config?.voicebank ?? null,
      pending: this.pending.size,
      lastDevice: this.stats.lastDevice,
      starts: this.stats.starts,
      recycles: this.stats.recycles,
      idleArmed: Boolean(this.idleTimer),
      stdio: STDIO.slice(),
    }
  }
}

export default createSingingProcess
