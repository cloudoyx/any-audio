import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
import { assertPackDir, isPriorityPack, listPacks, readPack, userSfxDir } from '../audio/sfx-library.js'
import { scanPackFolder } from '../audio/sfx-pack-scan.js'
import { EDGE_VOICES, MIMO_VOICES, DEEPSEEK_VOICES, providerInfo, resolveVoice, synthesizeSpeech } from '../audio/tts-providers.js'
import {
  installVoicebankFromZip, listSingingVoices, runSingingInstall,
  singingRoot, singingStatus, VOICEBANK_SOURCES,
} from '../audio/singing-install.js'
import { gpuStatus, installGpuRuntime } from '../audio/singing-gpu.js'
import { encodeWav, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { mergedCatalog, timbresFromPrograms } from '../audio/vst3-catalog.js'
import { runVst3Install, vst3Root, vst3Status } from '../audio/vst3-install.js'
import { recognizeVst3 } from '../audio/vst3-known.js'
import { createVst3Process } from '../audio/vst3-process.js'
import { configPath, readConfig, resetConfig, updateConfig } from '../config.js'
import { findFfmpeg, resolveOutputPath, runFfmpeg, scratchPath } from '../tools/shared.js'
import { handleClipBay, needsClientHeader } from './clipbay-routes.js'
import { describeError, json, readJsonBody } from './http.js'

const PREFIX = '/api/dsh-any-audio'
const CLIENT_HEADER = 'any-audio/1'
// Read the version from the package manifest so the settings page never shows a
// stale number after a release bump.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

const jobs = new Map()
const audios = new Map()

// Injectable so the settings/acceptance tests can drive the install job without
// touching the network or the real machine-wide directory (same pattern as the
// singing process factory used by the singing tool).
let singingInstallRunner = runSingingInstall
export function setSingingInstallRunner(fn) {
  singingInstallRunner = typeof fn === 'function' ? fn : runSingingInstall
}
// Injectable local-zip installer for offline tests (same pattern as above).
let voicebankZipInstaller = installVoicebankFromZip
export function setVoicebankZipInstaller(fn) {
  voicebankZipInstaller = typeof fn === 'function' ? fn : installVoicebankFromZip
}
// Injectable GPU installer/probe for offline route tests (same pattern).
let gpuInstallRunner = installGpuRuntime
export function setGpuInstallRunner(fn) {
  gpuInstallRunner = typeof fn === 'function' ? fn : installGpuRuntime
}
let gpuStatusProbe = gpuStatus
export function setGpuStatusProbe(fn) {
  gpuStatusProbe = typeof fn === 'function' ? fn : gpuStatus
}
// Injectable VST3 runtime installer for offline route tests (same pattern as the
// singing install runner above).
let vst3InstallRunner = runVst3Install
export function setVst3InstallRunner(fn) {
  vst3InstallRunner = typeof fn === 'function' ? fn : runVst3Install
}
// Injectable VST3 process factory for offline route tests (same pattern as the
// singing install runner above). The settings preview reuses one process; the
// manager's idle exit closes it after 60s with no request.
let vst3ProcessFactory = (options) => createVst3Process(options)
let vst3Process = null
export function setVst3ProcessFactory(fn) {
  vst3ProcessFactory = typeof fn === 'function' ? fn : (options) => createVst3Process(options)
  vst3Process = null
}
function getVst3Process() {
  if (!vst3Process) vst3Process = vst3ProcessFactory()
  return vst3Process
}
/** Stop the shared preview process (tests and plugin disposal). */
export async function shutdownVst3Process() {
  const current = vst3Process
  vst3Process = null
  if (current) await current.shutdown().catch(() => {})
}

/**
 * Parse a bundle's moduleinfo.json, or null when there is none.
 *
 * The VST3 SDK writes this file with trailing commas (it is JSON5-ish), which
 * JSON.parse rejects. Dropping a comma that sits right before } or ] is enough
 * to read the real metadata instead of silently falling back to the folder
 * name for every Ample plugin.
 */
async function readVst3ModuleJson(packagePath) {
  try {
    const text = await readFile(join(packagePath, 'Contents', 'Resources', 'moduleinfo.json'), 'utf8')
    return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'))
  } catch {
    return null
  }
}

/** Read Name/Vendor from a VST3 package's moduleinfo.json; empty on failure. */
async function readVst3ModuleInfo(packagePath) {
  const data = await readVst3ModuleJson(packagePath)
  if (!data) return { name: '', vendor: '' }
  const name = typeof data.Name === 'string' ? data.Name.trim() : ''
  const vendor = typeof data['Factory Info']?.Vendor === 'string' ? data['Factory Info'].Vendor.trim() : ''
  return { name, vendor }
}

/**
 * Does a bundle's moduleinfo.json declare an Instrument class?
 * `true` / `false` when the metadata was read, `null` when there is none
 * (single-file plugins have no Contents/Resources/moduleinfo.json).
 */
async function readVst3DeclaredInstrument(packagePath) {
  const data = await readVst3ModuleJson(packagePath)
  if (!data) return null
  const classes = Array.isArray(data.Classes) ? data.Classes : []
  return classes.some((entry) => Array.isArray(entry?.['Sub Categories']) && entry['Sub Categories'].includes('Instrument'))
}

/**
 * Recursively find .vst3 plugins in both Windows forms: a directory bundle
 * (Contents/x86_64-win/<name>.vst3) and a single-file .vst3, which is itself a
 * loadable DLL. Bundles without the inner DLL are skipped; a single file needs
 * no inner check. Every candidate says which form it is (`form`) and whether
 * its metadata declares an Instrument (`declaredInstrument`).
 */
export async function scanVst3Packages(root) {
  const found = []
  const seen = new Set()
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const isVst3 = entry.name.toLowerCase().endsWith('.vst3')
      if (entry.isDirectory()) {
        if (isVst3) {
          const key = full.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          let hasInnerDll = false
          try {
            const inner = await readdir(join(full, 'Contents', 'x86_64-win'), { withFileTypes: true })
            hasInnerDll = inner.some((item) => item.isFile() && item.name.toLowerCase().endsWith('.vst3'))
          } catch {
            hasInnerDll = false
          }
          if (!hasInnerDll) continue
          const meta = await readVst3ModuleInfo(full)
          const name = meta.name || entry.name.replace(/\.vst3$/i, '')
          found.push({
            path: full,
            name,
            vendor: meta.vendor,
            hasInnerDll: true,
            form: 'bundle',
            declaredInstrument: await readVst3DeclaredInstrument(full),
            recognized: recognizeVst3(name),
          })
          continue
        }
        await walk(full)
        continue
      }
      if (!entry.isFile() || !isVst3) continue
      const key = full.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      // A single-file .vst3 is the DLL itself: no moduleinfo to read, no inner
      // DLL to check. The file name is the only name available.
      const name = entry.name.replace(/\.vst3$/i, '')
      found.push({
        path: full,
        name,
        vendor: '',
        hasInnerDll: false,
        form: 'single',
        declaredInstrument: null,
        recognized: recognizeVst3(name),
      })
    }
  }
  await walk(root)
  return found
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    label: job.label ?? null,
    status: job.status,
    received: job.received,
    total: job.total,
    message: job.message,
    error: job.error,
    errorCode: job.errorCode ?? null,
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

function startJob(kind, runner, label = '') {
  const id = randomUUID()
  const job = { id, kind, label, status: 'running', received: 0, total: 0, message: '', startedAt: Date.now(), abort: new AbortController() }
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
      // A stable id for failures the settings page can say in the person's own
      // language. The message itself stays as it is: it is also what the agent
      // reads from the tool, and it names the fix.
      job.errorCode = typeof error?.code === 'string' ? error.code : null
      job.finishedAt = Date.now()
    })
  return job
}

function runningJob(kind) {
  for (const job of jobs.values()) {
    if (job.kind === kind && job.status === 'running') return job
  }
  return null
}

/** A short name for the progress line; a malformed URL must not break the call. */
function urlLabel(url) {
  try {
    return basename(new URL(url).pathname) || url
  } catch {
    return url
  }
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
  const available = RECOMMENDED_FONTS.filter((preset) => !preset.hidden).map((preset) => {
    const row = rows.find((entry) => entry.recommendedId === preset.id)
    return {
      id: preset.id,
      name: preset.name,
      file: preset.file,
      bytes: preset.bytes,
      archiveBytes: preset.archiveBytes ?? null,
      manual: preset.manual ?? null,
      url: preset.url ?? null,
      links: preset.links ?? [],
      license: preset.license,
      note: preset.note,
      tagline: preset.tagline ?? '',
      scores: preset.scores,
      default: Boolean(preset.default),
      suggested: Boolean(preset.suggested),
      installed: Boolean(row),
      status: row?.status ?? 'missing',
    }
  })
  // Two different things answer to "default" in this page: the bank the person
  // actually chose (music.font), and the bank a render falls back to when they
  // chose nothing. Showing only the resolved path made the fallback look like a
  // setting, so "默认音源：GeneralUser" read as "I configured this" while the
  // tools kept reporting "not set" (improvement plan 04).
  const { config } = await readConfig()
  const resolved = await resolveConfiguredDefault(config.music.font, { workspaceRoot }).catch(() => null)
  const defaultPath = resolved?.path ?? null
  const configured = resolved?.configured ?? ''
  const stale = resolved?.stale === true
  const fallbackPath = (await resolveConfiguredDefault('', { workspaceRoot }).catch(() => null))?.path ?? null
  return { rows, available, defaultPath, configured, stale, fallbackPath, directories: fontSearchDirs(), libraryDir: userFontDir() }
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
    let deepseekConfigured = false
    if (credentials) {
      try {
        const info = await credentials.describe('DEEPSEEK_API_KEY')
        deepseekConfigured = Boolean(info?.configured ?? info?.present ?? info?.value)
      } catch {
        deepseekConfigured = false
      }
    }
    if (!deepseekConfigured && process.env.DEEPSEEK_API_KEY) deepseekConfigured = true
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
          providerInfo('deepseek'),
        ],
        edgeVoices: EDGE_VOICES,
        mimoVoices: MIMO_VOICES,
        deepseekVoices: DEEPSEEK_VOICES,
        mimoConfigured,
        deepseekConfigured,
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

  /** Singing runtime status: what of the three artefacts is installed. */
  async function singingStatusRoute() {
    try {
      return { ok: true, ...(await singingStatus()) }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  /** Installed singing voicebanks for the settings dropdown. */
  async function singingVoicesRoute() {
    try {
      return await listSingingVoices()
    } catch (error) {
      return { ok: false, voices: [], error: describeError(error) }
    }
  }

  /** Public download sources for the official voicebank zip (GitHub / net-disk). */
  function singingSourcesRoute() {
    return { ok: true, sources: VOICEBANK_SOURCES }
  }

  /** Install the voicebank from a local official zip (verified by SHA-256). */
  async function singingInstallZipRoute(body) {
    const zipPath = typeof body?.zipPath === 'string' ? body.zipPath.trim() : ''
    if (!zipPath) return { ok: false, error: 'zipPath is required', code: 'BAD_ZIP_PATH' }
    try {
      const status = await voicebankZipInstaller({
        zipPath,
        onProgress: (event) => {
          // A local install is quick; surface the phase for parity with jobs.
          if (event.message) note(`singing/install-zip: ${event.message}`)
        },
      })
      return { ok: true, status }
    } catch (error) {
      return { ok: false, error: describeError(error), code: error?.code ?? 'INSTALL_FAILED' }
    }
  }

  /** Status of the optional CUDA acceleration component. */
  async function singingGpuStatusRoute() {
    try {
      return { ok: true, ...(await gpuStatusProbe()) }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  /** Start (or join) a GPU-component install job (measures mirrors, then installs). */
  async function singingGpuInstallRoute(body) {
    const running = runningJob('singing-gpu-install')
    if (running) return { ok: true, job: publicJob(running), reused: true }
    const job = startJob('singing-gpu-install', async (current) => {
      current.message = 'preparing'
      const result = await gpuInstallRunner({
        signal: current.abort.signal,
        onProgress: (event) => {
          if (event.received !== undefined) {
            current.received = event.received
            current.total = event.total ?? 0
          }
          if (event.message) current.message = event.message
          else if (event.phase) current.message = event.phase
        },
      })
      current.message = 'ready'
      return result
    }, 'singing GPU component')
    return { ok: true, job: publicJob(job), reused: false }
  }

  /** Start (or join) a singing-environment install job. */
  async function singingInstallRoute(body) {
    // One install at a time: a second request joins the running job so two
    // downloads never race on the same `.part` file (same as installSource).
    const running = runningJob('singing-install')
    if (running) return { ok: true, job: publicJob(running), reused: true }
    const job = startJob('singing-install', async (current) => {
      current.message = 'preparing'
      const result = await singingInstallRunner({
        signal: current.abort.signal,
        onProgress: (event) => {
          if (event.received !== undefined) {
            current.received = event.received
            current.total = event.total ?? 0
          }
          if (event.message) current.message = event.message
          else if (event.phase) current.message = event.phase
        },
      })
      current.message = 'ready'
      return result
    }, 'singing environment')
    return { ok: true, job: publicJob(job), reused: false, root: singingRoot() }
  }

  async function installSource(body) {
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : 'generaluser'
    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined
    const fromPath = typeof body.fromPath === 'string' && body.fromPath.trim() ? body.fromPath.trim() : undefined
    // One install at a time: a second request must join the running job instead
    // of starting a parallel download that would write the same ".part" file.
    const running = runningJob('install')
    if (running) return { ok: true, job: publicJob(running), reused: true }
    const label = url ? urlLabel(url) : fromPath ? basename(fromPath) : findRecommended(id)?.name ?? id
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
    }, label)
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
    const requested = body.provider
    const explicit = requested !== undefined && requested !== null && String(requested).trim() !== ''
    const chosenEngine = String(explicit ? requested : config.tts.provider)
    const info = providerInfo(chosenEngine)
    if (!info) throw new Error(`unknown provider "${chosenEngine}"`)
    // The voice picker in the page belongs to the selected engine, so a
    // mismatch means a name from the other engine came in. Preview has to give
    // the same answer the tools do, or it lies about what a call would do.
    const picked = resolveVoice({
      provider: chosenEngine,
      voice: body.voice,
      explicitProvider: explicit,
      fallbackVoice: configuredVoiceFor(config, chosenEngine),
    })
    const provider = picked.provider
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
    if (provider === 'deepseek') {
      apiKey = process.env.DEEPSEEK_API_KEY ?? null
      const credentials = getCredentials()
      if (!apiKey && credentials) {
        try {
          apiKey = (await credentials.resolve('DEEPSEEK_API_KEY'))?.value ?? null
        } catch {
          apiKey = null
        }
      }
      if (!apiKey) throw new Error('DeepSeek TTS uses the account DSH signs in with, and none was found. Sign in with a DeepSeek account, or set DEEPSEEK_API_KEY')
    }
    const text = String(body.text ?? '').trim() || '太行、王屋二山，方七百里，高万仞。'
    const voice = picked.voice
    const audio = await synthesizeSpeech({
      provider,
      text,
      voice,
      rate: body.rate ?? config.tts.edge.rate,
      pitch: body.pitch ?? config.tts.edge.pitch,
      volume: body.volume ?? config.tts.edge.volume,
      style: body.style,
      proxy: provider === 'mimo' ? config.tts.mimo.proxy || undefined : provider === 'deepseek' ? config.tts.deepseek.proxy || undefined : config.tts.edge.proxy || undefined,
      baseUrl: provider === 'deepseek' ? config.tts.deepseek.baseUrl : config.tts.mimo.baseUrl,
      model: config.tts.mimo.model,
      timeoutSec: provider === 'deepseek' ? config.tts.deepseek.timeoutSec : config.tts.mimo.timeoutSec,
      apiKey,
      sampleRate: 48000,
    })
    const payload = audioPayload(audio.channels, audio.sampleRate)
    delete payload.buffer
    return rememberAudio(encodeWav({ sampleRate: audio.sampleRate, channels: audio.channels, bitDepth: 16 }), {
      kind: 'tts',
      label: `${info.label} / ${voice}`,
      ...payload,
    })
  }

  const VST3_SCAN_DIR = 'C:\\Program Files\\Common Files\\VST3'

  /** VST3 render-runtime status: is the runtime installed, and can it import the deps. */
  async function vst3StatusRoute() {
    try {
      return { ok: true, ...(await vst3Status()) }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  /** Start (or join) a VST3 render-runtime install job. */
  async function vst3InstallRoute() {
    // One install at a time: a second request joins the running job so two
    // downloads never race on the same `.part` file (same as singingInstallRoute).
    const running = runningJob('vst3-install')
    if (running) return { ok: true, job: publicJob(running), reused: true }
    const job = startJob('vst3-install', async (current) => {
      current.message = 'preparing'
      const result = await vst3InstallRunner({
        signal: current.abort.signal,
        onProgress: (event) => {
          if (event.received !== undefined) {
            current.received = event.received
            current.total = event.total ?? 0
          }
          if (event.message) current.message = event.message
          else if (event.phase) current.message = event.phase
        },
      })
      current.message = 'ready'
      return result
    }, 'VST3 runtime')
    return { ok: true, job: publicJob(job), reused: false, root: vst3Root() }
  }

  async function vst3ScanRoute(body) {
    const requested = typeof body.dir === 'string' && body.dir.trim() ? body.dir.trim() : VST3_SCAN_DIR
    let info
    try {
      info = await stat(requested)
    } catch {
      throw new Error(`VST3 目录不存在：${requested}`)
    }
    if (!info.isDirectory()) throw new Error(`不是目录：${requested}`)
    const plugins = await scanVst3Packages(requested)
    return { ok: true, dir: requested, plugins }
  }

  /**
   * Ask the sidecar which named program parameters the plugin exposes and turn
   * them into parameter-type timbres. Any failure — not an instrument, no
   * pedalboard, plugin crash — means "no parameter presets": adding a plugin
   * must not fail because it cannot be probed.
   */
  async function probeParameterTimbres(path) {
    try {
      const manager = getVst3Process()
      if (typeof manager.probe !== 'function') return []
      const { programs } = await manager.probe(path)
      return timbresFromPrograms(programs)
    } catch {
      return []
    }
  }

  /** Store parameter timbres next to whatever vendor presets the path already has. */
  function mergeTimbres(stored, path, timbres) {
    const key = path.toLowerCase()
    const index = stored.findIndex((entry) => String(entry.path ?? '').toLowerCase() === key)
    if (index < 0) return [...stored, { path, timbres }]
    const existing = stored[index].timbres ?? []
    const seen = new Set(existing.map((item) => item.id))
    const merged = [...existing, ...timbres.filter((item) => !seen.has(item.id))]
    return stored.map((entry, at) => (at === index ? { path: stored[index].path, timbres: merged } : entry))
  }

  async function vst3AddRoute(body) {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (!path) throw new Error('path is required')
    if (!existsSync(path)) throw new Error(`VST3 插件不存在：${path}`)
    const { config } = await readConfig()
    const existing = (config.vst3?.plugins ?? []).find((entry) => entry.path.toLowerCase() === path.toLowerCase())
    if (existing) throw new Error(`VST3 插件已存在：${path}`)
    const meta = await readVst3ModuleInfo(path)
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : (meta.name || basename(path).replace(/\.vst3$/i, '') || path)
    const vendor = typeof body.vendor === 'string' && body.vendor.trim()
      ? body.vendor.trim()
      : meta.vendor
    const plugins = [...(config.vst3?.plugins ?? []), { path, name, vendor }]
    const updated = await updateConfig({ vst3: { plugins } })
    // A plugin that exposes a named program parameter gets parameter-type
    // timbres, so a score can switch its sound by preset name.
    const timbres = await probeParameterTimbres(path)
    if (timbres.length === 0) return { ok: true, plugin: { path, name, vendor }, config: updated.config }
    const stored = updated.config.vst3?.timbres ?? []
    const final = await updateConfig({ vst3: { timbres: mergeTimbres(stored, path, timbres) } })
    return { ok: true, plugin: { path, name, vendor }, timbres, config: final.config }
  }

  async function vst3RemoveRoute(body) {
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (!path) throw new Error('path is required')
    const { config } = await readConfig()
    const plugins = config.vst3?.plugins ?? []
    const next = plugins.filter((entry) => entry.path.toLowerCase() !== path.toLowerCase())
    if (next.length === plugins.length) return { ok: false, error: `VST3 插件不在配置里：${path}` }
    const updated = await updateConfig({ vst3: { plugins: next } })
    return { ok: true, removed: true, config: updated.config }
  }

  /** Built-in + scanned VST3 instrument catalog for the settings page. */
  async function vst3ListRoute() {
    const catalog = await mergedCatalog()
    // The catalog entry exists whether or not the plugin is on this machine;
    // `installed` is what lets the page tell "recommended" from "already here".
    return {
      ok: true,
      ...catalog,
      plugins: catalog.plugins.map((entry) => ({ ...entry, installed: existsSync(entry.plugin) })),
    }
  }

  /**
   * Render a short note with one VST3 instrument and return it as a preview
   * clip, the same shape /sources/preview returns. The settings page plays it
   * through the existing /audio route.
   */
  async function vst3TestRoute(body) {
    const catalog = await mergedCatalog()
    const requested = typeof body.plugin === 'string' ? body.plugin.trim() : ''
    const entry = requested
      ? catalog.plugins.find((item) => item.id === requested)
        ?? catalog.plugins.find((item) => item.name === requested)
        ?? catalog.plugins.find((item) => basename(item.plugin).toLowerCase() === requested.toLowerCase())
        ?? null
      : catalog.plugins[0]
    const pluginPath = entry?.plugin ?? requested
    if (!pluginPath) throw new Error('vst3/test needs a plugin id or path')
    if (!existsSync(pluginPath)) throw new Error(`音源插件不存在：${pluginPath}`)
    // The preview follows the instrument family: a guitar gets a downstroke
    // across the open D/G/A shapes, everything else keeps the arpeggio. The
    // arpeggio root sits 4 semitones above the measured low end and 12 below the
    // high end so the octave jump stays in range; an unmeasured plugin gets MIDI
    // 55, a safe centre.
    let notes
    let duration
    if (entry?.families?.guitar) {
      const chords = [
        { start: 0.0, pitches: [50, 57, 62, 66, 69], dur: 0.9, vel: 100 },
        { start: 1.0, pitches: [50, 57, 62, 66, 69], dur: 0.9, vel: 100 },
        { start: 2.0, pitches: [55, 59, 62, 67, 71], dur: 0.9, vel: 100 },
        { start: 3.0, pitches: [45, 52, 57, 61, 64], dur: 1.4, vel: 110 },
      ]
      notes = chords.flatMap((chord) => chord.pitches.map((pitch, index) => ({
        pitch,
        start: chord.start + index * 0.018,
        dur: chord.dur,
        vel: chord.vel,
      })))
      duration = 5.2
    } else {
      const range = entry?.range
      const root = range
        ? Math.min(Math.max(55, range.low + 4), range.high - 12)
        : 55
      const intervals = [0, 4, 7, 12, 7, 4, 0, 7]
      notes = intervals.map((interval, index) => ({
        pitch: root + interval,
        start: index * 0.25,
        dur: 0.22,
        vel: index === intervals.length - 1 ? 110 : 100,
      }))
      duration = 2.8
    }
    const out = scratchPath(workspaceRoot, `vst3-preview-${randomUUID()}.wav`)
    await mkdir(dirname(out), { recursive: true })
    let result
    let buffer
    try {
      result = await getVst3Process().render({ plugin: pluginPath, notes, duration, out })
      buffer = await readFile(out)
    } finally {
      await rm(out, { force: true })
    }
    return rememberAudio(buffer, {
      kind: 'vst3',
      label: `${entry?.name ?? basename(pluginPath)} · 试听`,
      durationSec: result.seconds,
      peakDb: Number(toDb(result.peak).toFixed(1)),
    })
  }

  /**
   * Which engine a credential request is about.
   *
   * The DeepSeek key belongs to DSH's own sign-in, so this service never writes
   * or clears it: deleting it would break the person's model access, not just
   * narration. Only engines whose key the plugin owns are writable here.
   */
  /**
   * The voice saved for an engine, read from that engine's own config block, so
   * a new engine needs no branch here.
   */
  function configuredVoiceFor(config, providerId) {
    const saved = config?.tts?.[providerId]?.voice
    if (typeof saved === 'string' && saved.trim()) return saved
    return providerInfo(providerId)?.voices?.[0] ?? ''
  }

  function credentialRefFor(body, { writable = true } = {}) {
    const requested = String(body?.provider ?? 'mimo').trim() || 'mimo'
    const info = providerInfo(requested)
    if (!info) throw new Error(`unknown provider "${requested}"`)
    if (!info.credentialRef) throw new Error(`${info.label} does not use an API key`)
    if (writable && info.keyIsAmbient) throw new Error(`${info.label} uses the account DSH signs in with; there is nothing to save here`)
    return { requested, ref: info.credentialRef, label: info.label }
  }

  async function credentialsStatus(body = {}) {
    const credentials = getCredentials()
    const { requested, ref } = credentialRefFor(body, { writable: false })
    const envName = ref
    const result = { ok: true, service: Boolean(credentials), provider: requested, ref, configured: Boolean(process.env[envName]), writable: !providerInfo(requested)?.keyIsAmbient }
    if (credentials) {
      try {
        const info = await credentials.describe(ref)
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
    const { ref, label } = credentialRefFor(body)
    const value = String(body.value ?? '').trim()
    if (!value) throw new Error('value is required')
    if (!/^[A-Za-z0-9_\-.]{8,}$/.test(value)) throw new Error('this does not look like an API key')
    await credentials.set(ref, value)
    void label
    return { ok: true, configured: true }
  }

  async function credentialsUnset(body) {
    const credentials = getCredentials()
    if (!credentials) throw new Error('the DSH credentials service is not available in this runtime')
    const { ref } = credentialRefFor(body)
    await credentials.unset(ref)
    return { ok: true, configured: false }
  }

  /**
   * The installed sound packs, with the two facts the settings page needs: how
   * many sounds each holds, and whether it is expanded in `catalog`.
   *
   * The context cost is an estimate, not a measurement: a priority pack's names
   * are what the agent reads, so the number is the character count of those
   * names at roughly 1.33 tokens per Chinese character. A normal pack costs
   * nothing until a search hits it, so it reports no number at all.
   */
  async function sfxPacks() {
    const { config } = await readConfig()
    const { packs, warnings } = await listPacks()
    const rows = packs.map((pack) => {
      const priority = isPriorityPack(config.sfx?.packs, pack.id)
      const characters = pack.sounds.reduce((sum, sound) => sum + sound.name.length, 0)
      return {
        id: pack.id,
        name: pack.name,
        version: pack.version,
        license: pack.license,
        count: pack.sounds.length,
        priority,
        tokens: priority ? Math.max(0.1, Math.round((characters * 1.33) / 100) / 10) : null,
        dir: pack.dir,
      }
    })
    rows.sort((a, b) => Number(b.priority) - Number(a.priority) || a.id.localeCompare(b.id))
    return { ok: true, packs: rows, root: userSfxDir(), warnings }
  }

  async function sfxPackToggle(body) {
    const packId = String(body.id ?? '').trim()
    if (!packId) throw new Error('id is required')
    const { config } = await readConfig()
    const current = isPriorityPack(config.sfx?.packs, packId)
    const next = body.priority === undefined ? !current : Boolean(body.priority)
    const { config: updated } = await updateConfig({
      sfx: { packs: { ...(config.sfx?.packs ?? {}), [packId]: next ? 'priority' : 'normal' } },
    })
    return { ok: true, id: packId, priority: next, packs: updated.sfx.packs }
  }

  /**
   * Install a pack folder.
   *
   * A folder with a manifest is copied as-is. A folder without one is scanned
   * first: the person pointed at a folder of audio, and asking them to run a
   * Node script before the button works is not a settings page.
   *
   * It runs as a job because reading the duration of every file takes a moment
   * on a large pack, and a frozen button is worse than a progress bar.
   */
  async function sfxPackInstall(body) {
    const fromPath = String(body.fromPath ?? '').trim()
    if (!fromPath) throw new Error('fromPath is required: the directory of the pack to install')
    const source = resolve(fromPath)
    await assertPackDir(source)
    const running = runningJob('pack-install')
    if (running) return { ok: true, job: publicJob(running), reused: true }
    const job = startJob('pack-install', async (current) => {
      const existing = await readPack(source, { packId: basename(source) })
      const warnings = []
      // `readPack` spreads the manifest into its result, so the pack itself is
      // the manifest plus `dir` and `warnings`.
      let manifest = existing ?? null
      let generated = false
      if (!manifest) {
        const scanned = await scanPackFolder(source, {
          packId: basename(source),
          signal: current.abort.signal,
          onProgress: (done, total) => {
            current.received = done
            current.total = total
          },
        })
        manifest = scanned.manifest
        warnings.push(...scanned.warnings)
        generated = true
      }
      const target = join(userSfxDir(), manifest.id)
      if (resolve(target) === source) {
        current.message = 'already there'
        return { ok: true, id: manifest.id, installed: true, alreadyThere: true, count: manifest.sounds.length, generated, warnings }
      }
      await mkdir(userSfxDir(), { recursive: true })
      await rm(target, { recursive: true, force: true })
      await cp(source, target, { recursive: true })
      if (generated) await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      current.message = generated ? 'installed (manifest generated)' : 'installed'
      return { ok: true, id: manifest.id, installed: true, count: manifest.sounds.length, dir: target, generated, warnings }
    }, basename(source))
    return { ok: true, job: publicJob(job) }
  }

  async function sfxPackRemove(body) {
    const packId = String(body.id ?? '').trim()
    if (!packId) throw new Error('id is required')
    const target = join(userSfxDir(), packId)
    // Only a direct child of the library may be removed: a crafted id must not
    // reach outside it.
    if (resolve(target) !== join(resolve(userSfxDir()), packId) || packId.includes('/') || packId.includes('\\')) {
      throw new Error(`"${packId}" is not a pack id`)
    }
    await rm(target, { recursive: true, force: true })
    const { config } = await readConfig()
    if (config.sfx?.packs?.[packId] !== undefined) {
      const next = { ...config.sfx.packs }
      delete next[packId]
      await updateConfig({ sfx: { packs: next } })
    }
    return { ok: true, id: packId, removed: true }
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
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ? '(set)' : null,
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

  /**
   * Static pictures that ship with the plugin.
   *
   * An `<img>` cannot send the client header, so this sits outside the gate the
   * same way the audio route does; the cross-site rejection above still applies.
   */
  async function assetRoute(res, name) {
    try {
      const buffer = await readFile(new URL(`../client/assets/${name}`, import.meta.url))
      res.writeHead(200, {
        'content-type': 'image/webp',
        'content-length': buffer.length,
        'cache-control': 'public, max-age=86400',
      })
      res.end(buffer)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('asset not found')
    }
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
    if (method === 'GET' && path === `${PREFIX}/assets/hero.webp`) {
      await assetRoute(res, 'hero.webp')
      return
    }
    if (path.startsWith(`${PREFIX}/clipbay/`)) {
      const suffix = path.slice(PREFIX.length)
      // The media routes sit outside the header gate: <audio>/<video> cannot
      // send a custom header, so only the cross-site rejection above protects them.
      if (needsClientHeader(suffix) && req.headers['x-any-audio-client'] !== CLIENT_HEADER) {
        return json(res, 403, { ok: false, error: 'requests must come from the AnyAudio settings page' })
      }
      return handleClipBay(req, res, { url, method, path: suffix, ctx })
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
    if (method === 'GET' && path === `${PREFIX}/singing/status`) {
      try {
        return json(res, 200, await singingStatusRoute())
      } catch (error) {
        return json(res, 500, { ok: false, error: describeError(error) })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/singing/voices`) {
      return json(res, 200, await singingVoicesRoute())
    }
    if (method === 'GET' && path === `${PREFIX}/singing/sources`) {
      return json(res, 200, singingSourcesRoute())
    }
    if (method === 'GET' && path === `${PREFIX}/singing/gpu-status`) {
      try {
        return json(res, 200, await singingGpuStatusRoute())
      } catch (error) {
        return json(res, 500, { ok: false, error: describeError(error) })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/credentials`) return json(res, 200, await credentialsStatus({ provider: url.searchParams.get('provider') ?? undefined }))
    if (method === 'GET' && path === `${PREFIX}/sources/presets`) {
      try {
        return json(res, 200, await presetsFor(url.searchParams.get('path')))
      } catch (error) {
        return json(res, 500, { ok: false, error: describeError(error) })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/vst3/status`) {
      try {
        return json(res, 200, await vst3StatusRoute())
      } catch (error) {
        return json(res, 500, { ok: false, error: describeError(error) })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/vst3/list`) {
      try {
        return json(res, 200, await vst3ListRoute())
      } catch (error) {
        return json(res, 500, { ok: false, error: describeError(error) })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/sfx/packs`) {
      try {
        return json(res, 200, await sfxPacks())
      } catch (error) {
        return json(res, 500, { ok: false, error: describeError(error) })
      }
    }
    if (method === 'GET' && path === `${PREFIX}/jobs`) {
      const job = jobs.get(url.searchParams.get('id') ?? '')
      return json(res, job ? 200 : 404, job ? { ok: true, job: publicJob(job) } : { ok: false, error: 'job not found' })
    }
    if (method === 'GET' && path === `${PREFIX}/jobs/active`) {
      const job = runningJob(url.searchParams.get('kind') ?? 'install')
      return json(res, 200, { ok: true, job: job ? publicJob(job) : null })
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
      if (path === `${PREFIX}/singing/install`) return json(res, 200, await singingInstallRoute(body))
      if (path === `${PREFIX}/singing/install-zip`) return json(res, 200, await singingInstallZipRoute(body))
      if (path === `${PREFIX}/singing/gpu-install`) return json(res, 200, await singingGpuInstallRoute(body))
      if (path === `${PREFIX}/sources/install`) return json(res, 200, await installSource(body))
      if (path === `${PREFIX}/sources/verify`) return json(res, 200, await verifySource(body))
      if (path === `${PREFIX}/sources/remove`) return json(res, 200, await removeSource(body))
      if (path === `${PREFIX}/sources/preview`) return json(res, 200, await previewSource(body))
      if (path === `${PREFIX}/vst3/install`) return json(res, 200, await vst3InstallRoute())
      if (path === `${PREFIX}/vst3/scan`) return json(res, 200, await vst3ScanRoute(body))
      if (path === `${PREFIX}/vst3/add`) return json(res, 200, await vst3AddRoute(body))
      if (path === `${PREFIX}/vst3/remove`) return json(res, 200, await vst3RemoveRoute(body))
      if (path === `${PREFIX}/vst3/test`) return json(res, 200, await vst3TestRoute(body))
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
      if (path === `${PREFIX}/credentials/unset`) return json(res, 200, await credentialsUnset(body))
      if (path === `${PREFIX}/sfx/packs/toggle`) return json(res, 200, await sfxPackToggle(body))
      if (path === `${PREFIX}/sfx/packs/install`) return json(res, 200, await sfxPackInstall(body))
      if (path === `${PREFIX}/sfx/packs/remove`) return json(res, 200, await sfxPackRemove(body))
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










