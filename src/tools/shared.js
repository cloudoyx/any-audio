import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { encodeWav } from '../audio/wav.js'

let workingDirectoryService

/** The DSH working-directory service is the only reliable source of the session cwd. */
export function setWorkingDirectoryService(service) {
  workingDirectoryService = service
}

/**
 * Resolve the workspace folder for the current tool call. The working-directory
 * service (dsh-working-directory) knows the session cwd; older agent shapes are
 * kept as fallbacks for other hosts. Returns null when nothing can be resolved,
 * so callers can demand an absolute output path instead of silently writing into
 * the harness profile directory.
 */
export async function workspaceRootOf(exec) {
  const agent = exec?.agent
  if (workingDirectoryService && agent) {
    try {
      const cwd = await workingDirectoryService.ensure(agent, exec.signal)
      if (typeof cwd === 'string' && cwd.trim()) return resolve(cwd)
    } catch {
      // fall through to the legacy shapes
    }
  }
  const candidates = [
    agent?.session?.header?.cwd,
    agent?.workspaceRoot,
    agent?.session?.workspaceRoot,
    agent?.session?.workspace?.path,
    agent?.workspace?.path,
    process.env.DSH_WORKSPACE,
    process.env.DSH_WORKSPACE_ROOT,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return resolve(candidate)
  }
  return null
}

export function outputDir(workspaceRoot) {
  return join(workspaceRoot, '.anyaudio', 'out')
}

/** Resolve a tool "output" argument to an absolute path inside the workspace by default. */
export function resolveOutput(workspaceRoot, output, defaultName) {
  if (typeof output === 'string' && output.trim()) {
    const candidate = isAbsolute(output) ? output : resolve(workspaceRoot, output)
    return candidate
  }
  return join(outputDir(workspaceRoot), defaultName)
}

export function relativeToWorkspace(workspaceRoot, path) {
  if (!workspaceRoot) return path
  const rel = relative(workspaceRoot, path)
  return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : path
}

/**
 * Resolve a tool "output" argument. An explicit value always wins; otherwise a
 * configured output directory is used, falling back to <workspace>/.anyaudio/out.
 * Without a workspace root only an absolute path is accepted: writing into the
 * harness profile directory would leave files nowhere near the user's project.
 */
export function resolveOutputPath({ workspaceRoot, outputDir: configuredDir, requested, defaultName }) {
  if (typeof requested === 'string' && requested.trim()) {
    if (isAbsolute(requested)) return requested
    if (!workspaceRoot) {
      throw new Error(`cannot resolve relative output "${requested}" without a workspace folder; pass an absolute path`)
    }
    return resolve(workspaceRoot, requested)
  }
  if (!workspaceRoot) {
    throw new Error(`cannot determine this session's workspace folder; pass "output" as an absolute path (for example <project>/.anyaudio/out/${defaultName})`)
  }
  const base = configuredDir && String(configuredDir).trim()
    ? (isAbsolute(String(configuredDir).trim()) ? String(configuredDir).trim() : resolve(workspaceRoot, String(configuredDir).trim()))
    : outputDir(workspaceRoot)
  return join(base, defaultName)
}

export async function writeWavFile(path, channels, sampleRate, bitDepth = 16) {
  await mkdir(dirname(path), { recursive: true })
  const buffer = encodeWav({ sampleRate, channels, bitDepth })
  await writeFile(path, buffer)
  const info = await stat(path)
  return { path, bytes: info.size }
}

export async function readJsonParam(value, what) {
  if (value && typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      return JSON.parse(await readFile(resolve(value), 'utf8'))
    } catch {
      try {
        return JSON.parse(value)
      } catch (error) {
        throw new Error(`${what} must be a JSON object (given text could not be parsed: ${error.message})`)
      }
    }
  }
  throw new Error(`${what} is required`)
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function seconds(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

let ffmpegCache

function probeBinary(command) {
  try {
    const result = spawnSync(command, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    if (result.status === 0) {
      const version = String(result.stdout ?? '').split('\n')[0]?.trim() ?? 'ffmpeg'
      return { command, version }
    }
  } catch {
    // ignore and try the next candidate
  }
  return null
}

/** Some Python environments ship an ffmpeg through imageio-ffmpeg; reuse it. */
function probePythonFfmpeg() {
  for (const python of ['python', 'python3', 'py']) {
    try {
      const result = spawnSync(python, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      if (result.status !== 0) continue
      const candidate = String(result.stdout ?? '').trim().split('\n')[0]
      if (candidate && existsSync(candidate)) {
        const probe = probeBinary(candidate)
        if (probe) return probe
      }
    } catch {
      // try the next interpreter
    }
  }
  return null
}

export function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache
  const candidates = [process.env.ANYAUDIO_FFMPEG, process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean)
  for (const command of candidates) {
    const probe = probeBinary(command)
    if (probe) {
      ffmpegCache = probe
      return ffmpegCache
    }
  }
  ffmpegCache = probePythonFfmpeg()
  return ffmpegCache
}

export function runFfmpeg(command, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

export function nowStamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export const textBlocks = (text) => [{ type: 'text', text }]

export const textRenderer = (summarize) => (args, value) => textBlocks(summarize(args, value))

export function jsonSafe(value) {
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function') continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : -120
  return value
}

export function finalizeTool(definition) {
  const execute = definition.execute
  return {
    ...definition,
    execute: async (args, exec) => jsonSafe(await execute(args, exec)),
  }
}
