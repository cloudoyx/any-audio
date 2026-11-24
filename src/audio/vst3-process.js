// Node-side lifecycle manager for the VST3 render worker (engine/vst3_worker.py).
//
// Protocol — one JSON line in / one JSON line out over pipes (no network port):
//   worker -> us  {"type":"ready","sampleRate":48000}
//   worker -> us  {"type":"result","id":N,"ok":true,"peak":0.79,"seconds":4.0}
//   worker -> us  {"type":"result","id":N,"ok":false,"kind":"param|load|render","error":"..."}
//   us -> worker  {"op":"render","id":N,"plugin":"...","notes":[...],"duration":4.0,"out":"...","preset":"..."}
//   us -> worker  {"op":"shutdown"}
//
// `preset` is optional: the path of a vendor preset state file. The worker swaps
// that state into the plugin's own state container before rendering; without it
// the plugin renders at its default state (a preset used by an earlier render is
// undone). A preset that cannot be loaded is a `kind:"load"` error, never a crash.
//
// Hard rules (same as singing-process.js):
//  - Start on demand, exit after idleSec (60s default) with nothing pending.
//  - Write request lines as UTF-8 BYTES to stdin (Buffer.from, no BOM); text-mode
//    or PowerShell encoding corrupts Chinese paths / produces JSON parse errors.
//  - stderr is INHERITED, never piped: an unread pipe fills up and deadlocks the worker.
//  - One process at a time. A dead process is replaced on the next request; the
//    previous failure is never carried into the new process.
//  - A render that exceeds renderTimeoutMs is an error AND the process is killed:
//    a hung plugin cannot be trusted to answer the next request.
//  - A venv python.exe is only a launcher; kill the whole process tree on shutdown.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { vst3Root, vst3RuntimeExe } from './vst3-install.js'

export const DEFAULT_IDLE_SEC = 60
export const DEFAULT_RENDER_TIMEOUT_MS = 120000

const READY_TIMEOUT_MS = 60000
const STDIO = ['pipe', 'pipe', 'inherit'] // index 2 = stderr inherited, NEVER 'pipe'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..')
const DEFAULT_WORKER = resolve(REPO_ROOT, 'engine', 'vst3_worker.py')
// A developer checkout's own venv. Kept only as the last resort: a person who
// installed the plugin has no repo, so the machine-wide runtime comes first.
const REPO_VENV_PYTHON = process.platform === 'win32'
  ? resolve(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
  : resolve(REPO_ROOT, '.venv', 'bin', 'python')

function envPath(name) {
  const value = process.env[name]
  return value && value.trim() ? resolve(value.trim()) : null
}

/**
 * The interpreter the sidecar launches, in priority order:
 *   1. `options.python` — an explicit override (tests, a custom build)
 *   2. ANYAUDIO_VST3_PYTHON — the same override from the environment
 *   3. the machine-wide runtime installed from the settings page
 *   4. the repo's own .venv — a developer checkout only
 * The first three are what a person who installed the plugin has; the venv is
 * the fallback that keeps a checkout working without an install step.
 */
export function resolveVst3Python(options = {}) {
  const explicit = options.python ?? envPath('ANYAUDIO_VST3_PYTHON')
  if (explicit) return explicit
  const installed = vst3RuntimeExe(vst3Root())
  if (existsSync(installed)) return installed
  return REPO_VENV_PYTHON
}

export class Vst3ProcessError extends Error {
  constructor(message, { code = 'VST3_ERROR', kind = 'render' } = {}) {
    super(message)
    this.name = 'Vst3ProcessError'
    this.code = code
    this.kind = kind
  }
}

/** Resolve the launch config. Passing `command` or `args` marks an injected
 *  worker (test mode): path checks for the real python/worker are skipped. */
export function resolveVst3Config(options = {}) {
  const injected = Boolean(options.command || options.args)
  const worker = options.worker ?? DEFAULT_WORKER
  const python = resolveVst3Python(options)
  const idleSec = Number.isFinite(Number(options.idleSec)) ? Number(options.idleSec) : DEFAULT_IDLE_SEC
  const idleMs = Math.max(100, Number.isFinite(Number(options.idleMs)) ? Number(options.idleMs) : idleSec * 1000)
  const renderTimeoutMs = Math.max(1, Number.isFinite(Number(options.renderTimeoutMs))
    ? Number(options.renderTimeoutMs)
    : DEFAULT_RENDER_TIMEOUT_MS)
  const readyTimeoutMs = Number.isFinite(Number(options.readyTimeoutMs))
    ? Number(options.readyTimeoutMs)
    : READY_TIMEOUT_MS
  const command = options.command ?? python
  const args = options.args ?? ['-X', 'utf8', worker]
  return { command, args, worker, python, idleMs, renderTimeoutMs, readyTimeoutMs, injected }
}

function validateConfig(config) {
  if (config.injected) return
  if (!existsSync(config.command)) {
    throw new Vst3ProcessError(
      `VST3 运行时未安装，请到 设置 → AnyAudio → 音源 安装（找不到 ${config.command}）`,
      { code: 'ENV_MISSING', kind: 'load' },
    )
  }
  if (!existsSync(config.worker)) {
    throw new Vst3ProcessError(`VST3 worker script not found: ${config.worker}`, {
      code: 'WORKER_MISSING', kind: 'load',
    })
  }
}

/** Validate and normalise a render task into the sidecar's note shape. */
function validateTask(task) {
  if (!task || typeof task !== 'object') {
    throw new Vst3ProcessError('render task must be an object', { code: 'BAD_TASK', kind: 'param' })
  }
  if (!task.plugin || typeof task.plugin !== 'string') {
    throw new Vst3ProcessError('plugin must be a VST3 path', { code: 'BAD_PLUGIN', kind: 'param' })
  }
  if (!task.out || typeof task.out !== 'string') {
    throw new Vst3ProcessError('out must be a WAV output path', { code: 'BAD_OUTPUT', kind: 'param' })
  }
  const duration = Number(task.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Vst3ProcessError('duration must be a positive number of seconds', {
      code: 'BAD_DURATION', kind: 'param',
    })
  }
  if (!Array.isArray(task.notes) || task.notes.length === 0) {
    throw new Vst3ProcessError('notes must be a non-empty array of { pitch, start, dur, vel }', {
      code: 'BAD_NOTES', kind: 'param',
    })
  }
  const notes = task.notes.map((note, index) => {
    const label = `note ${index + 1}`
    if (!note || typeof note !== 'object') {
      throw new Vst3ProcessError(`${label} must be an object`, { code: 'BAD_NOTES', kind: 'param' })
    }
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
      throw new Vst3ProcessError(`${label} pitch must be an integer 0-127`, { code: 'BAD_NOTES', kind: 'param' })
    }
    const start = Number(note.start ?? 0)
    if (!Number.isFinite(start) || start < 0) {
      throw new Vst3ProcessError(`${label} start must be a non-negative number`, { code: 'BAD_NOTES', kind: 'param' })
    }
    const dur = Number(note.dur)
    if (!Number.isFinite(dur) || dur <= 0) {
      throw new Vst3ProcessError(`${label} dur must be a positive number`, { code: 'BAD_NOTES', kind: 'param' })
    }
    const vel = note.vel ?? 100
    if (!Number.isInteger(vel) || vel < 0 || vel > 127) {
      throw new Vst3ProcessError(`${label} vel must be an integer 0-127`, { code: 'BAD_NOTES', kind: 'param' })
    }
    return { pitch: note.pitch, start, dur, vel }
  })
  const keyswitches = Array.isArray(task.keyswitches)
    ? task.keyswitches.filter((pitch) => Number.isInteger(pitch) && pitch >= 0 && pitch <= 127)
    : []
  if (task.preset !== undefined && task.preset !== null && typeof task.preset !== 'string') {
    throw new Vst3ProcessError('preset must be a path to a preset state file', {
      code: 'BAD_PRESET', kind: 'param',
    })
  }
  const preset = typeof task.preset === 'string' ? task.preset.trim() : ''
  return {
    plugin: task.plugin,
    notes,
    duration,
    out: task.out,
    ...(keyswitches.length ? { keyswitches } : {}),
    ...(preset ? { preset } : {}),
  }
}

export function createVst3Process(options = {}) {
  return new Vst3Process(options)
}

class Vst3Process {
  constructor(options) {
    this.base = options
    this.child = null
    this.config = null
    this.ready = null
    this.buffer = ''
    this.seq = 0
    this.pending = new Map()
    this.idleTimer = null
    this.queue = Promise.resolve()
    this.stats = { starts: 0 }
  }

  _config() {
    return resolveVst3Config(this.base)
  }

  // Serialise every operation: two concurrent renders must never start two
  // processes or race on the same stdin.
  _enqueue(fn) {
    const result = this.queue.then(fn, fn)
    this.queue = result.catch(() => {})
    return result
  }

  /** Start the worker (if needed) and wait for its ready line. */
  ensureReady() {
    return this._enqueue(async () => {
      const config = this._config()
      if (!this.child) await this._start(config)
      this._armIdle(config.idleMs)
      return { ...this.ready }
    })
  }

  /** Render one clip. Returns { peak, seconds }; worker errors carry `kind`. */
  render(task) {
    return this._enqueue(async () => {
      const config = this._config()
      const payload = validateTask(task)
      if (!this.child) await this._start(config)
      this._cancelIdle()

      const id = ++this.seq
      try {
        // Direct UTF-8 bytes, no BOM — this is what keeps Chinese paths intact.
        this.child.stdin.write(Buffer.from(JSON.stringify({ op: 'render', id, ...payload }) + '\n', 'utf8'))
      } catch (err) {
        this._stopNow().catch(() => {})
        throw new Vst3ProcessError(`Cannot write to VST3 worker: ${err.message}`, {
          code: 'WRITE_FAILED', kind: 'render',
        })
      }

      let result
      try {
        result = await this._waitFor(id, config.renderTimeoutMs)
      } finally {
        this._armIdle(config.idleMs)
      }
      return result
    })
  }

  _waitFor(id, timeoutMs) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Vst3ProcessError(
          `VST3 render timed out after ${Math.round(timeoutMs / 1000)}s (id=${id}).`,
          { code: 'RENDER_TIMEOUT', kind: 'render' },
        ))
        // A hung plugin cannot be trusted to answer the next request.
        this._stopNow().catch(() => {})
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
        rejectStart(new Vst3ProcessError(`Cannot spawn VST3 worker: ${err.message}`, {
          code: 'SPAWN_FAILED', kind: 'load',
        }))
        return
      }
      this.child = child
      this.config = config
      this.buffer = ''
      this.ready = null

      let settled = false
      const settleReady = (info) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ready = info
        this.stats.starts += 1
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
        settleFail(new Vst3ProcessError(
          `VST3 worker did not become ready within ${Math.round(config.readyTimeoutMs / 1000)}s.`,
          { code: 'START_TIMEOUT', kind: 'load' },
        ))
        this._stopNow().catch(() => {})
      }, config.readyTimeoutMs)
      timer.unref?.()
      this._settleReady = { settleReady, settleFail, settled: () => settled }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        if (this.child !== child) return // a replaced process must not answer for the new one
        this.buffer += chunk
        let idx
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 1)
          if (line.trim()) this._onLine(line)
        }
      })
      child.stdin.on('error', (err) => {
        if (this.child !== child) return
        this._failAll(new Vst3ProcessError(`VST3 worker stdin failed: ${err.message}`, {
          code: 'WRITE_FAILED', kind: 'render',
        }))
      })
      child.on('error', (err) => {
        const wrapped = new Vst3ProcessError(
          `Cannot start VST3 worker (${config.command}): ${err.message}`,
          { code: 'SPAWN_FAILED', kind: 'load' },
        )
        const current = this.child === child
        if (current) this._resetChild()
        if (current) this._failAll(wrapped)
        settleFail(wrapped)
      })
      child.on('exit', () => {
        const current = this.child === child
        if (current) this._resetChild()
        if (!settled) {
          settleFail(new Vst3ProcessError('VST3 worker exited before it was ready.', {
            code: 'WORKER_EXITED', kind: 'load',
          }))
        } else if (current) {
          this._failAll(new Vst3ProcessError('VST3 worker exited unexpectedly.', {
            code: 'WORKER_EXITED', kind: 'render',
          }))
        }
      })
    })
  }

  _resetChild() {
    this.child = null
    this.config = null
    this.ready = null
    this.buffer = ''
    this._settleReady = null
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
      const err = new Vst3ProcessError(msg.error || 'VST3 worker fatal error', {
        code: 'WORKER_FATAL', kind: 'load',
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
        const kind = msg.kind === 'param' || msg.kind === 'load' ? msg.kind : 'render'
        waiter.reject(new Vst3ProcessError(msg.error || 'VST3 render failed', {
          code: kind === 'param' ? 'BAD_REQUEST' : kind === 'load' ? 'LOAD_FAILED' : 'RENDER_FAILED',
          kind,
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
      this.shutdown().catch(() => {})
    }, idleMs)
    this.idleTimer.unref?.()
  }

  _stopNow() {
    this._cancelIdle()
    const child = this.child
    this._resetChild()
    this._failAll(new Vst3ProcessError('VST3 worker stopped.', { code: 'STOPPED', kind: 'render' }))
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
  shutdown() {
    return this._enqueue(() => this._stopNow())
  }

  /** Diagnostics for tests / the tool layer — never exposes the child or its pipes. */
  getState() {
    return {
      running: Boolean(this.child),
      pid: this.child?.pid ?? null,
      ready: this.ready ? { ...this.ready } : null,
      worker: this.config?.worker ?? null,
      pending: this.pending.size,
      starts: this.stats.starts,
      idleArmed: Boolean(this.idleTimer),
      stdio: STDIO.slice(),
    }
  }
}

export default createVst3Process
