import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  FONT_EXTENSIONS,
  RECOMMENDED_FONTS,
  findRecommended,
  findRecommendedByFile,
  fontSearchDirs,
  installFont,
  listFonts,
  sha256File,
  userFontDir,
} from '../audio/fonts.js'
import { deleteFont, describeFonts, forgetFont, updateFontEntry } from '../audio/font-state.js'
import { resolveConfiguredDefault } from '../audio/banks.js'
import { categoryOfProgram } from '../audio/scoring.js'
import { compileScore } from '../audio/score.js'
import { loadSoundBank, renderCompiled, listPresets } from '../audio/synth.js'
import { EDGE_VOICES, MIMO_VOICES, providerInfo, synthesizeSpeech } from '../audio/tts-providers.js'
import { encodeWav, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { configPath, readConfig, resetConfig, updateConfig } from '../config.js'
import { findFfmpeg, resolveOutputPath, runFfmpeg } from '../tools/shared.js'

const PREFIX = '/api/dsh-any-audio'
const CLIENT_HEADER = 'any-audio/1'
const VERSION = '0.1.0'

const jobs = new Map()
const audios = new Map()

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    received: job.received,
    total: job.total,
    message: job.message,
    error: job.error,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

function startJob(kind, runner) {
  const id = randomUUID()
  const job = { id, kind, status: 'running', received: 0, total: 0, message: '', startedAt: Date.now(), abort: new AbortController() }
  jobs.set(id, job)
  runner(job)
    .then((result) => {
      job.status = 'done'
      job.result = result
      job.finishedAt = Date.now()
    })
    .catch((error) => {
      if (job.status === 'cancelled') return
      job.status = 'error'
      job.error = describeError(error)
      job.finishedAt = Date.now()
    })
  return job
}

/** Recommended fonts plus whatever is installed, merged for the UI. */
async function fontState(workspaceRoot) {
  const installed = await listFonts()
  const described = await describeFonts(installed)
  const byPath = new Map(described.map((entry) => [entry.path, entry]))
  const rows = []
  for (const font of installed) {
    const recommended = findRecommendedByFile(font.name)
    const state = byPath.get(font.path)
    rows.push({
      name: font.name,
      path: font.path,
      bytes: font.bytes,
      source: font.source,
      scope: font.source === 'user' ? 'user' : 'custom',
      recommendedId: recommended?.id ?? null,
      license: recommended?.license ?? 'custom font — check its license before redistributing',
      managed: Boolean(state?.sha256),
      sha256: state?.sha256 ?? null,
      installedAt: state?.installedAt ?? null,
      verifiedAt: state?.verifiedAt ?? null,
      status: state ? (state.mismatch ? 'modified' : 'ok') : 'unmanaged',
    })
  }
  const available = RECOMMENDED_FONTS.map((preset) => {
    const row = rows.find((entry) => entry.recommendedId === preset.id)
    return {
      id: preset.id,
      name: preset.name,
      file: preset.file,
      bytes: preset.bytes,
      archiveBytes: preset.archiveBytes ?? null,
      manual: preset.manual ?? null,
      url: preset.url ?? null,
      license: preset.license,
      note: preset.note,
      scores: preset.scores,
      default: Boolean(preset.default),
      suggested: Boolean(preset.suggested),
      installed: Boolean(row),
      status: row?.status ?? 'missing',
    }
  })
  const defaultPath = await configuredDefaultPath(workspaceRoot).catch(() => null)
  return { rows, available, defaultPath, directories: fontSearchDirs(), libraryDir: userFontDir() }
}

/**
 * The bank renders actually land on. Sharing `resolveConfiguredDefault` with the
 * music tool is what keeps the page from showing a default that no longer
 * exists while renders silently use another one.
 */
async function configuredDefaultPath(workspaceRoot) {
  const { config } = await readConfig()
  const resolved = await resolveConfiguredDefault(config.music.font, { workspaceRoot })
  return resolved.path
}

function makeRoutes({ ctx, log, workspaceRoot }) {
  const note = (message) => {
    try {
      if (typeof log === 'function') log(message)
      else log?.info?.(message)
    } catch {
      /* logging must never break a request */
    }
  }
  const getCredentials = () => ctx.get('credentials')

  async function state() {
    const { config } = await readConfig()
    const fonts = await fontState(workspaceRoot)
    const ffmpeg = findFfmpeg()
    const credentials = getCredentials()
    let mimoConfigured = false
    if (credentials) {
      try {
        const info = await credentials.describe('MIMO_API_KEY')
        mimoConfigured = Boolean(info?.configured ?? info?.present ?? info?.value)
      } catch {
        mimoConfigured = false
      }
    }
    if (!mimoConfigured && process.env.MIMO_API_KEY) mimoConfigured = true
    return {
      ok: true,
      version: VERSION,
      config,
      configPath: configPath(),
      fonts,
      ffmpeg: ffmpeg ? { path: ffmpeg.command, version: ffmpeg.version } : null,
      tts: {
        providers: [
          providerInfo('edge'),
          providerInfo('mimo'),
        ],
        edgeVoices: EDGE_VOICES,
        mimoVoices: MIMO_VOICES,
        mimoConfigured,
      },
      platform: { node: process.version, home: homedir(), fontLibrary: userFontDir() },
    }
  }

  async function configUpdate(body) {
    const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : body
    if (!patch || typeof patch !== 'object') throw new Error('patch object is required')
    const { config, path } = await updateConfig(patch)
    return { ok: true, config, configPath: path }
  }

  async function configReset() {
    const { config, path } = await resetConfig()
    return { ok: true, config, configPath: path }
  }

  async function installSource(body) {
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : 'generaluser'
    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined
    const fromPath = typeof body.fromPath === 'string' && body.fromPath.trim() ? body.fromPath.trim() : undefined
    const job = startJob('install', async (current) => {
      const result = await installFont({
        id,
        url,
        fromPath,
        workspaceRoot,
        signal: current.abort.signal,
        onProgress: ({ received, total }) => {
          current.received = received
          current.total = total ?? 0
        },
      })
      const recommended = findRecommended(id) ?? findRecommendedByFile(basename(result.path))
      await updateFontEntry(result.path, {
        bytes: result.bytes,
        sha256: result.sha256,
        source: url ? 'download' : fromPath ? 'file' : 'download',
        license: recommended?.license ?? result.license,
        verifiedAt: Date.now(),
        id: recommended?.id ?? null,
      })
      current.message = result.alreadyInstalled ? 'already installed' : 'installed'
      return { ...result, name: basename(result.path), id: recommended?.id ?? null }
    })
    return { ok: true, job: publicJob(job) }
  }

  async function verifySource(body) {
    const path = String(body.path ?? '')
    if (!existsSync(path)) throw new Error(`font not found: ${path}`)
    const digest = await sha256File(path)
    const recommended = findRecommendedByFile(basename(path))
    const expected = recommended?.sha256 ?? null
    const mismatch = Boolean(expected && digest !== expected)
    await updateFontEntry(path, { sha256: digest, verifiedAt: Date.now(), mismatch })
    return { ok: !mismatch, path, sha256: digest, expected, mismatch, status: mismatch ? 'modified' : 'ok' }
  }

  async function removeSource(body) {
    const path = String(body.path ?? '')
    const removeFile = body.removeFile === true
    const { config } = await readConfig()
    const configured = typeof config.music.font === 'string' ? config.music.font.trim() : ''
    let clearsDefault = false
    if (removeFile && configured) {
      // Only clear the saved default when the file going away is the one it
      // resolves to: deleting an unrelated bank must leave the default alone.
      // A default that is already stale resolves to the fallback bank, which is
      // not what the setting says — leave that value for the renderer to report.
      const resolved = await resolveConfiguredDefault(configured, { workspaceRoot }).catch(() => null)
      const doomed = await realpath(resolve(path)).catch(() => null)
      const target = resolved && !resolved.stale ? await realpath(resolved.path).catch(() => null) : null
      clearsDefault = Boolean(doomed && target && doomed === target)
    }
    const result = removeFile
      ? await deleteFont(path, { dirs: [userFontDir()] })
      : await forgetFont(path)
    if (clearsDefault) await updateConfig({ music: { font: '' } })
    const note = removeFile ? 'file deleted' : 'file kept on disk; only the plugin record was removed'
    return { ok: true, path, removed: removeFile, defaultCleared: clearsDefault, note, ...result }
  }

  function rememberAudio(buffer, meta) {
    const id = randomUUID()
    const item = { buffer, ...meta, createdAt: Date.now() }
    audios.set(id, item)
    setTimeout(() => audios.delete(id), 10 * 60 * 1000).unref?.()
    return { id, url: `${PREFIX}/audio?id=${id}`, ...meta }
  }

  function audioPayload(channels, sampleRate) {
    const buffer = encodeWav({ sampleRate, channels, bitDepth: 16 })
    return {
      buffer,
      durationSec: Number((channels[0].length / sampleRate).toFixed(3)),
      peakDb: Number(toDb(peakOf(channels)).toFixed(1)),
      rmsDb: Number(toDb(rmsOf(channels)).toFixed(1)),
    }
  }

  async function presetsFor(path) {
    const target = String(path ?? '')
    if (!target || !existsSync(target)) throw new Error(`font not found: ${target || '(empty path)'}`)
    const bank = await loadSoundBank(target)
    const presets = listPresets(bank, { limit: 400 })
    const melodic = presets
      .filter((preset) => !preset.drums)
      .map((preset) => ({
        program: preset.program,
        name: preset.name,
        bank: preset.bank,
        family: categoryOfProgram(preset.program),
      }))
      .sort((a, b) => a.program - b.program || a.bank - b.bank)
    return {
      ok: true,
      path: target,
      file: basename(target),
      presets: melodic,
      drums: presets.filter((preset) => preset.drums).length,
    }
  }

  async function previewSource(body) {
    const path = String(body.path ?? '')
    if (!existsSync(path)) throw new Error(`font not found: ${path}`)
    const seconds = Math.min(8, Math.max(1, Number(body.seconds) || 4))
    const sampleRate = 48000
    const bank = await loadSoundBank(path)
    const presets = listPresets(bank, { limit: 400 })
    const melodic = presets.filter((preset) => !preset.drums)
    const requested = Number.isFinite(Number(body.program)) ? Number(body.program) : null
    const program = requested ?? melodic[0]?.program ?? 0
    const preset = presets.find((candidate) => candidate.program === program && !candidate.drums)
    if (!preset) {
      throw new Error(`font "${basename(path)}" has no melodic preset for program ${program}`)
    }
    const notes = [
      [0.0, 0.9, 'C4', 88], [0.9, 0.9, 'E4', 84], [1.8, 0.9, 'G4', 88], [2.7, 0.9, 'C5', 96],
      [0.0, 3.4, ['C3', 'G3'], 70],
    ]
    const score = {
      title: `preview ${basename(path)} program ${program}`,
      tracks: [{ name: 'preview', instrument: program, gainDb: -3, reverb: 0.3, notes }],
    }
    const compiled = compileScore(score, { sampleRate })
    const rendered = await renderCompiled(compiled, {
      sampleRate,
      durationSec: seconds,
      banks: [{ bank, id: 'preview', offset: 0 }],
      layout: new Map([['preview', { offset: 0, program }]]),
      peakDb: -3,
    })
    return rememberAudio(encodeWav({ sampleRate, channels: rendered.channels, bitDepth: 16 }), {
      kind: 'source',
      label: `${basename(path)} · ${preset.name}`,
      durationSec: rendered.durationSec,
      peakDb: rendered.peakDb,
    })
  }

  async function previewTts(body) {
    const { config } = await readConfig()
    const provider = String(body.provider ?? config.tts.provider)
    const info = providerInfo(provider)
    if (!info) throw new Error(`unknown provider "${provider}"`)
    let apiKey = null
    if (provider === 'mimo') {
      apiKey = process.env.MIMO_API_KEY ?? null
      const credentials = getCredentials()
      if (!apiKey && credentials) {
        try {
          apiKey = (await credentials.resolve('MIMO_API_KEY'))?.value ?? null
        } catch {
          apiKey = null
        }
      }
      if (!apiKey) throw new Error('MiMo needs a key: save one above (normal Open Platform key) or set MIMO_API_KEY')
    }
    const text = String(body.text ?? '').trim() || '太行、王屋二山，方七百里，高万仞。'
    const voice = String(body.voice ?? (provider === 'mimo' ? config.tts.mimo.voice : config.tts.edge.voice))
    const audio = await synthesizeSpeech({
      provider,
      text,
      voice,
      rate: body.rate ?? config.tts.edge.rate,
      pitch: body.pitch ?? config.tts.edge.pitch,
      volume: body.volume ?? config.tts.edge.volume,
      style: body.style ?? config.tts.mimo.style,
      proxy: provider === 'mimo' ? config.tts.mimo.proxy || undefined : config.tts.edge.proxy || undefined,
      baseUrl: config.tts.mimo.baseUrl,
      model: config.tts.mimo.model,
      timeoutSec: config.tts.mimo.timeoutSec,
      apiKey,
      sampleRate: 48000,
    })
    const payload = audioPayload(audio.channels, audio.sampleRate)
    delete payload.buffer
    return rememberAudio(encodeWav({ sampleRate: audio.sampleRate, channels: audio.channels, bitDepth: 16 }), {
      kind: 'tts',
      label: `${provider} / ${voice}`,
      ...payload,
    })
  }

  async function credentialsStatus() {
    const credentials = getCredentials()
    const result = { ok: true, service: Boolean(credentials), ref: 'MIMO_API_KEY', configured: Boolean(process.env.MIMO_API_KEY) }
    if (credentials) {
      try {
        const info = await credentials.describe('MIMO_API_KEY')
        result.configured = Boolean(result.configured || info?.configured || info?.present)
        result.info = info ?? null
      } catch (error) {
        result.error = describeError(error)
      }
    }
    return result
  }

  async function credentialsSet(body) {
    const credentials = getCredentials()
    if (!credentials) throw new Error('the DSH credentials service is not available in this runtime')
    const value = String(body.value ?? '').trim()
    if (!value) throw new Error('value is required')
    if (!/^[A-Za-z0-9_\-.]{8,}$/.test(value)) throw new Error('this does not look like an API key')
    await credentials.set('MIMO_API_KEY', value)
    return { ok: true, configured: true }
  }

  async function credentialsUnset() {
    const credentials = getCredentials()
    if (!credentials) throw new Error('the DSH credentials service is not available in this runtime')
    await credentials.unset('MIMO_API_KEY')
    return { ok: true, configured: false }
  }

  function diagnostics() {
    const ffmpeg = findFfmpeg()
    return {
      ok: true,
      version: VERSION,
      node: process.version,
      configPath: configPath(),
      fontDirs: fontSearchDirs(),
      ffmpeg: ffmpeg ? { path: ffmpeg.command, version: ffmpeg.version } : null,
      env: {
        ANYAUDIO_FONT: process.env.ANYAUDIO_FONT ?? null,
        ANYAUDIO_FONT_DIR: process.env.ANYAUDIO_FONT_DIR ?? null,
        ANYAUDIO_FONTS: process.env.ANYAUDIO_FONTS ?? null,
        ANYAUDIO_CONFIG: process.env.ANYAUDIO_CONFIG ?? null,
        MIMO_API_KEY: process.env.MIMO_API_KEY ? '(set)' : null,
      },
    }
  }

  async function audioRoute(res, id) {
    const item = audios.get(String(id ?? ''))
    if (!item) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('audio expired')
      return
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': item.buffer.length, 'cache-control': 'no-store' })
    res.end(item.buffer)
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '')
    if (fetchSite === 'cross-site') {
      return json(res, 403, { ok: false, error: 'cross-site requests are not allowed' })
    }
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()
    if (path === `${PREFIX}/audio`) {
      await audioRoute(res, url.searchParams.get('id'))
      return
    }
    if (req.headers['x-any-audio-client'] !== CLIENT_HEADER) {
      return json(res, 403, { ok: false, error: 'requests must come from the AnyAudio settings page' })
    }
    if (method === 'GET' && path === `${PREFIX}/state`) {
      try {
        return json(res, 200, await state())
      } catch (error) {
        const detail = String(error?.stack ?? '').split('\n').slice(0, 8).join('\n')
        return json(res, 500, { ok: false, error: describeError(error), detail })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/diagnostics`) return json(res, 200, diagnostics())
    if (method === 'GET' && path === `${PREFIX}/credentials`) return json(res, 200, await credentialsStatus())
    if (method === 'GET' && path === `${PREFIX}/sources/presets`) {
      try {
        return json(res, 200, await presetsFor(url.searchParams.get('path')))
      } catch (error) {
        return json(res, 500, { ok: false, error: describeError(error) })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/jobs`) {
      const job = jobs.get(url.searchParams.get('id') ?? '')
      return json(res, job ? 200 : 404, job ? { ok: true, job: publicJob(job) } : { ok: false, error: 'job not found' })
    }
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return json(res, 400, { ok: false, error: describeError(error) })
    }
    try {
      if (path === `${PREFIX}/config`) return json(res, 200, await configUpdate(body))
      if (path === `${PREFIX}/config/reset`) return json(res, 200, await configReset())
      if (path === `${PREFIX}/sources/install`) return json(res, 200, await installSource(body))
      if (path === `${PREFIX}/sources/verify`) return json(res, 200, await verifySource(body))
      if (path === `${PREFIX}/sources/remove`) return json(res, 200, await removeSource(body))
      if (path === `${PREFIX}/sources/preview`) return json(res, 200, await previewSource(body))
      if (path === `${PREFIX}/tts/preview`) return json(res, 200, await previewTts(body))
      if (path === `${PREFIX}/tts/cancel`) {
        const job = jobs.get(String(body.jobId ?? ''))
        if (job && job.status === 'running') {
          job.status = 'cancelled'
          job.abort.abort()
          job.finishedAt = Date.now()
        }
        return json(res, 200, { ok: true })
      }
      if (path === `${PREFIX}/credentials/set`) return json(res, 200, await credentialsSet(body))
      if (path === `${PREFIX}/credentials/unset`) return json(res, 200, await credentialsUnset())
      return json(res, 404, { ok: false, error: `unknown route ${path}` })
    } catch (error) {
      note(`any-audio route ${path} failed: ${describeError(error)}`)
      const detail = String(error?.stack ?? '').split('\n').slice(0, 6).join('\n')
      return json(res, 500, { ok: false, error: describeError(error), detail })
    }
  }

  return { route, state, diagnostics }
}

/**
 * Register the settings bridge. Everything is best-effort: a missing web server
 * only disables the settings page, never the agent tools.
 */
export function registerAnyAudioRoutes(ctx, { log, workspaceRoot = process.cwd() } = {}) {
  const note = (message) => {
    try {
      if (typeof log === 'function') log(message)
      else log?.info?.(message)
    } catch {
      /* logging must never break startup */
    }
  }
  const server = ctx.get('webServer')
  if (!server?.register) {
    note('any-audio: webServer is unavailable, the settings page will not be served')
    return { dispose: () => {} }
  }
  const routes = makeRoutes({ ctx, log, workspaceRoot })
  const dispose = server.register({ kind: 'prefix', path: PREFIX, handler: routes.route })
  return { dispose, routes }
}

export const __routesTest = { startJob, fontState }










