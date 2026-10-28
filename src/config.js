import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * One config file per machine, shared by every DSH profile. DSH's own settings
 * service is profile-scoped (forms persist through the active profile), so it
 * cannot hold values the user expects to keep across profiles. This file is the
 * single source of truth for AnyAudio behaviour; the plugin entry config in
 * cordis.patch.yml is deliberately ignored except for "settingsPath".
 */
export const CONFIG_VERSION = 1

export const DEFAULTS = {
  version: CONFIG_VERSION,
  ui: {
    language: 'auto',
  },
  tts: {
    provider: 'edge',
    previewText: '太行、王屋二山，方七百里，高万仞。',
    edge: {
      voice: 'zh-CN-YunjianNeural',
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
      proxy: '',
    },
    mimo: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts',
      voice: 'mimo_default',
      style: '',
      proxy: '',
      timeoutSec: 120,
    },
  },
  music: {
    font: '',
    peakDb: -3,
    sampleRate: 48000,
    tailSec: 2,
  },
  sfx: {
    peakDb: -4,
    sampleRate: 48000,
  },
  mix: {
    masterPeakDb: -1.5,
    sampleRate: 48000,
    ducking: {
      enabled: true,
      targetDb: -9,
      thresholdDb: -42,
      attackSec: 0.12,
      releaseSec: 0.4,
    },
  },
  output: {
    dir: '',
  },
  sources: {
    extraDirs: [],
    scores: {},
  },
}

const PROVIDERS = ['edge', 'mimo']
const UI_LANGUAGES = ['auto', 'zh', 'en']
const EDGE_VOICES = [
  'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunyangNeural',
  'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural',
  'ja-JP-NanamiNeural',
]
export const TTS_PROVIDER_IDS = PROVIDERS
export { EDGE_VOICES }

export function configPath() {
  const override = process.env.ANYAUDIO_CONFIG
  if (override && override.trim()) return join(override.trim())
  return join(homedir(), '.dsh', 'anyaudio', 'config.json')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function merge(base, patch) {
  if (!isPlainObject(patch)) return base
  const result = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = merge(result[key], value)
    else result[key] = value
  }
  return result
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function text(value, fallback, maxLength = 400) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLength)
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeDucking(value, base) {
  const source = isPlainObject(value) ? value : {}
  return {
    enabled: bool(source.enabled, base.enabled),
    targetDb: clampNumber(source.targetDb, -40, 0, base.targetDb),
    thresholdDb: clampNumber(source.thresholdDb, -80, -10, base.thresholdDb),
    attackSec: clampNumber(source.attackSec, 0.01, 5, base.attackSec),
    releaseSec: clampNumber(source.releaseSec, 0.01, 10, base.releaseSec),
  }
}

/** Validate/repair a candidate config and report what was changed. */
export function normalizeConfig(input) {
  const issues = []
  const raw = isPlainObject(input) ? input : {}
  if (!isPlainObject(input)) issues.push('config is not a JSON object; defaults are used')

  const uiRaw = isPlainObject(raw.ui) ? raw.ui : {}
  const language = UI_LANGUAGES.includes(uiRaw.language) ? uiRaw.language : DEFAULTS.ui.language
  if (uiRaw.language !== undefined && language !== uiRaw.language) issues.push(`ui.language "${String(uiRaw.language)}" is unknown; using "${language}"`)

  const ttsRaw = isPlainObject(raw.tts) ? raw.tts : {}
  const provider = PROVIDERS.includes(ttsRaw.provider) ? ttsRaw.provider : DEFAULTS.tts.provider
  if (ttsRaw.provider !== undefined && provider !== ttsRaw.provider) issues.push(`tts.provider "${String(ttsRaw.provider)}" is unknown; using "${provider}"`)
  const edgeRaw = isPlainObject(ttsRaw.edge) ? ttsRaw.edge : {}
  const mimoRaw = isPlainObject(ttsRaw.mimo) ? ttsRaw.mimo : {}

  const musicRaw = isPlainObject(raw.music) ? raw.music : {}
  const music = {
    font: typeof musicRaw.font === 'string' ? musicRaw.font.trim() : DEFAULTS.music.font,
    peakDb: musicRaw.peakDb === null ? null : clampNumber(musicRaw.peakDb, -60, 0, DEFAULTS.music.peakDb),
    sampleRate: Math.round(clampNumber(musicRaw.sampleRate, 8000, 192000, DEFAULTS.music.sampleRate)),
    tailSec: clampNumber(musicRaw.tailSec, 0, 60, DEFAULTS.music.tailSec),
  }

  const sfxRaw = isPlainObject(raw.sfx) ? raw.sfx : {}
  const mixRaw = isPlainObject(raw.mix) ? raw.mix : {}
  const outputRaw = isPlainObject(raw.output) ? raw.output : {}
  const sourcesRaw = isPlainObject(raw.sources) ? raw.sources : {}
  const extraDirs = Array.isArray(sourcesRaw.extraDirs)
    ? sourcesRaw.extraDirs.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    : []
  const scores = {}
  if (isPlainObject(sourcesRaw.scores)) {
    for (const [id, families] of Object.entries(sourcesRaw.scores)) {
      if (!isPlainObject(families)) continue
      const clean = {}
      for (const [family, score] of Object.entries(families)) {
        const number = Number(score)
        if (Number.isFinite(number)) clean[family] = Math.min(10, Math.max(1, Math.round(number)))
      }
      if (Object.keys(clean).length) scores[id] = clean
    }
  }

  return {
    issues,
    config: {
      version: CONFIG_VERSION,
      ui: {
        language,
      },
      tts: {
        provider,
        previewText: text(ttsRaw.previewText, DEFAULTS.tts.previewText, 2000),
        edge: {
          voice: typeof edgeRaw.voice === 'string' && edgeRaw.voice.trim() ? edgeRaw.voice.trim() : DEFAULTS.tts.edge.voice,
          rate: normalizePercentText(edgeRaw.rate, DEFAULTS.tts.edge.rate),
          pitch: normalizeHzText(edgeRaw.pitch, DEFAULTS.tts.edge.pitch),
          volume: normalizePercentText(edgeRaw.volume, DEFAULTS.tts.edge.volume),
          proxy: typeof edgeRaw.proxy === 'string' ? edgeRaw.proxy.trim() : '',
        },
        mimo: {
          baseUrl: text(mimoRaw.baseUrl, DEFAULTS.tts.mimo.baseUrl, 300).replace(/\/+$/, ''),
          model: text(mimoRaw.model, DEFAULTS.tts.mimo.model, 120),
          voice: text(mimoRaw.voice, DEFAULTS.tts.mimo.voice, 120),
          style: typeof mimoRaw.style === 'string' ? mimoRaw.style.slice(0, 500) : '',
          proxy: typeof mimoRaw.proxy === 'string' ? mimoRaw.proxy.trim() : '',
          timeoutSec: Math.round(clampNumber(mimoRaw.timeoutSec, 10, 600, DEFAULTS.tts.mimo.timeoutSec)),
        },
      },
      music,
      sfx: {
        peakDb: sfxRaw.peakDb === null ? null : clampNumber(sfxRaw.peakDb, -60, 0, DEFAULTS.sfx.peakDb),
        sampleRate: Math.round(clampNumber(sfxRaw.sampleRate, 8000, 192000, DEFAULTS.sfx.sampleRate)),
      },
      mix: {
        masterPeakDb: mixRaw.masterPeakDb === null ? null : clampNumber(mixRaw.masterPeakDb, -60, 0, DEFAULTS.mix.masterPeakDb),
        sampleRate: Math.round(clampNumber(mixRaw.sampleRate, 8000, 192000, DEFAULTS.mix.sampleRate)),
        ducking: normalizeDucking(mixRaw.ducking, DEFAULTS.mix.ducking),
      },
      output: {
        dir: typeof outputRaw.dir === 'string' ? outputRaw.dir.trim() : '',
      },
      sources: { extraDirs, scores },
    },
  }
}

function normalizePercentText(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value >= 0 ? '+' : ''}${value}%`
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  return /^[+-]/.test(raw) ? raw : `+${raw}`
}

function normalizeHzText(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value >= 0 ? '+' : ''}${value}Hz`
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  if (/[a-z]/i.test(raw)) return raw
  return `${Number(raw) >= 0 ? '+' : ''}${raw}Hz`
}

let cache = { path: null, mtimeMs: 0, size: 0, value: null }

/**
 * Read the shared config. A missing file is normal: defaults are returned and
 * saved lazily by the first write (the settings page), never by a tool call.
 */
export async function readConfig() {
  const path = configPath()
  let info = null
  try {
    info = await stat(path)
  } catch {
    const normalized = normalizeConfig(DEFAULTS)
    return { path, config: normalized.config, issues: [], exists: false, mtimeMs: 0 }
  }
  if (cache.path === path && cache.mtimeMs === info.mtimeMs && cache.size === info.size && cache.value) {
    return { path, config: cache.value.config, issues: cache.value.issues, exists: true, mtimeMs: info.mtimeMs }
  }
  let parsed
  let issues = []
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    parsed = {}
    issues.push(`existing config could not be parsed (${error instanceof Error ? error.message : String(error)}); defaults are used`)
  }
  const normalized = normalizeConfig(parsed)
  issues = [...issues, ...normalized.issues]
  cache = { path, mtimeMs: info.mtimeMs, size: info.size, value: { config: normalized.config, issues } }
  return { path, config: normalized.config, issues, exists: true, mtimeMs: info.mtimeMs }
}

async function writeConfigFile(path, config) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Patch the shared config. Only known fields survive validation, so a bad
 * request cannot corrupt the file; the merged result is written atomically.
 */
export async function updateConfig(patch) {
  const current = await readConfig()
  const merged = merge(current.config, patch)
  const normalized = normalizeConfig(merged)
  const path = configPath()
  await writeConfigFile(path, normalized.config)
  cache = { path, mtimeMs: 0, size: 0, value: null }
  return { path, config: normalized.config, issues: normalized.issues }
}

export async function resetConfig() {
  const normalized = normalizeConfig(DEFAULTS)
  const path = configPath()
  await writeConfigFile(path, normalized.config)
  cache = { path, mtimeMs: 0, size: 0, value: null }
  return { path, config: normalized.config }
}

/** Resolve the output directory for tools (config override wins). */
export async function configuredOutputDir() {
  const { config } = await readConfig()
  return config.output.dir || ''
}
