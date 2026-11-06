/**
 * Project file shape: defaults, validation and the schemaVersion migration hook.
 *
 * project.json is the single source of truth for arrangement (spec §6.2); the
 * material index is a separate file with its own rules (spec §6.4). Everything
 * here works on plain objects so the store, the routes, the renderer and the
 * agent tools all share one definition.
 */

export const SCHEMA_VERSION = 1

/** Hard project limits (spec §5.5). Exceeding them is an error, never a silent clamp. */
export const LIMITS = { durationSec: 15 * 60, tracks: 20 }

export const TRACK_CATEGORIES = ['music', 'tts', 'ambience', 'foley', 'other', 'video-audio']

export const MATERIAL_KINDS = ['music', 'music-stem', 'tts', 'sfx', 'ambience', 'video-audio', 'imported']

export class ProjectSchemaError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProjectSchemaError'
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message) {
  throw new ProjectSchemaError(message)
}

function text(value, path, { allowEmpty = false, max = 200 } = {}) {
  if (typeof value !== 'string') fail(`${path} must be a string`)
  const trimmed = value.trim()
  if (!allowEmpty && !trimmed) fail(`${path} must not be empty`)
  if (trimmed.length > max) fail(`${path} is longer than ${max} characters`)
  return trimmed
}

function number(value, path, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path} must be a finite number`)
  if (value < min || value > max) fail(`${path} must be between ${min} and ${max}, got ${value}`)
  return value
}

function flag(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`)
  return value
}

function choice(value, path, allowed) {
  if (!allowed.includes(value)) fail(`${path} must be one of ${allowed.join(' | ')}, got ${String(value)}`)
  return value
}

/** A path stored in project.json/index.json must stay inside the project folder. */
export function assertRelativePath(value, path) {
  const raw = text(value, path, { max: 400 })
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) {
    fail(`${path} must be relative to the project folder, got "${raw}"`)
  }
  const segments = raw.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) fail(`${path} must not escape the project folder, got "${raw}"`)
  return raw.replace(/\\/g, '/')
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

function timestamp(value, path) {
  if (typeof value !== 'string' || !ISO.test(value)) fail(`${path} must be an ISO-8601 UTC timestamp`)
  return value
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function defaultTrack(id, name = id) {
  return {
    id,
    name,
    category: 'other',
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    items: [],
  }
}

export function defaultItem(id, material) {
  return {
    id,
    material,
    startSec: 0,
    inSec: 0,
    outSec: 0,
    gainDb: 0,
    pan: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    muted: false,
    label: '',
  }
}

export function emptyProject({ id, name, sampleRate = 48000, createdAt = nowIso() } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    sampleRate,
    durationSec: 0,
    normalizeGainDb: 0,
    masterFaderDb: 0,
    createdAt,
    modifiedAt: createdAt,
    history: [{ at: createdAt, by: 'agent', note: 'created' }],
    video: null,
    tracks: [],
  }
}

/**
 * Fill in fields a hand-written or older file may be missing, then report the
 * current schemaVersion. v1 is the only version, so the migration body is empty
 * by design — but it must exist and be called (plan M0), or a later field
 * addition silently mishandles every file written before it.
 */
export function migrate(raw) {
  if (!isPlainObject(raw)) fail('project file is not a JSON object')
  const version = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1
  if (version < 1) fail(`project schemaVersion ${version} is not valid`)
  if (version > SCHEMA_VERSION) {
    fail(`project schemaVersion ${version} is newer than this plugin understands (${SCHEMA_VERSION})`)
  }

  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso()
  const project = {
    ...emptyProject({ id: raw.id, name: raw.name ?? 'untitled', sampleRate: raw.sampleRate ?? 48000, createdAt }),
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    history: Array.isArray(raw.history) ? raw.history : [],
    tracks: Array.isArray(raw.tracks) ? raw.tracks : [],
    video: raw.video === undefined ? null : raw.video,
  }
  project.tracks = project.tracks.map((track) => ({
    ...defaultTrack(track?.id, track?.name),
    ...track,
    items: Array.isArray(track?.items) ? track.items : [],
  }))
  return project
}

/** End of the last thing on the timeline; a longer video wins (spec §10.3, plan M3). */
export function contentEndSec(project) {
  let end = 0
  for (const track of project?.tracks ?? []) {
    for (const item of track?.items ?? []) {
      const length = Math.max(0, Number(item?.outSec) - Number(item?.inSec))
      const start = Number(item?.startSec)
      if (Number.isFinite(start) && Number.isFinite(length)) end = Math.max(end, start + length)
    }
  }
  const video = Number(project?.video?.durationSec)
  if (Number.isFinite(video)) end = Math.max(end, video)
  return Number(end.toFixed(6))
}

/**
 * Validate an already-migrated project. Rejects instead of repairing: a value
 * the caller got wrong must surface, not be silently replaced with a default.
 */
export function validateProject(project) {
  if (!isPlainObject(project)) fail('project must be an object')
  if (project.schemaVersion !== SCHEMA_VERSION) {
    fail(`project.schemaVersion must be ${SCHEMA_VERSION}, got ${String(project.schemaVersion)}`)
  }
  const id = text(project.id, 'project.id', { max: 120 })
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`project.id may only contain letters, digits, "-" and "_", got "${id}"`)
  text(project.name, 'project.name')
  number(project.sampleRate, 'project.sampleRate', { min: 8000, max: 192000 })
  if (!Number.isInteger(project.sampleRate)) fail('project.sampleRate must be an integer')
  number(project.normalizeGainDb, 'project.normalizeGainDb', { min: -120, max: 120 })
  number(project.masterFaderDb, 'project.masterFaderDb', { min: -120, max: 120 })
  timestamp(project.createdAt, 'project.createdAt')
  timestamp(project.modifiedAt, 'project.modifiedAt')

  if (!Array.isArray(project.history)) fail('project.history must be an array')
  project.history.forEach((entry, index) => {
    const path = `project.history[${index}]`
    if (!isPlainObject(entry)) fail(`${path} must be an object`)
    timestamp(entry.at, `${path}.at`)
    choice(entry.by, `${path}.by`, ['user', 'agent'])
    text(entry.note, `${path}.note`, { max: 500 })
  })

  if (project.video !== null && project.video !== undefined) {
    const video = project.video
    if (!isPlainObject(video)) fail('project.video must be an object or null')
    assertRelativePath(video.path, 'project.video.path')
    number(video.durationSec, 'project.video.durationSec', { min: 0 })
    flag(video.locked, 'project.video.locked')
  }

  if (!Array.isArray(project.tracks)) fail('project.tracks must be an array')
  if (project.tracks.length > LIMITS.tracks) {
    fail(`a project may hold at most ${LIMITS.tracks} tracks, this one has ${project.tracks.length}`)
  }
  const trackIds = new Set()
  const itemIds = new Set()
  project.tracks.forEach((track, trackIndex) => {
    const base = `project.tracks[${trackIndex}]`
    if (!isPlainObject(track)) fail(`${base} must be an object`)
    const trackId = text(track.id, `${base}.id`, { max: 120 })
    if (trackIds.has(trackId)) fail(`${base}.id "${trackId}" is used by another track`)
    trackIds.add(trackId)
    text(track.name, `${base}.name`)
    choice(track.category, `${base}.category`, TRACK_CATEGORIES)
    number(track.volumeDb, `${base}.volumeDb`, { min: -120, max: 24 })
    number(track.pan, `${base}.pan`, { min: -1, max: 1 })
    flag(track.muted, `${base}.muted`)
    flag(track.solo, `${base}.solo`)

    if (!Array.isArray(track.items)) fail(`${base}.items must be an array`)
    track.items.forEach((item, itemIndex) => {
      const at = `${base}.items[${itemIndex}]`
      if (!isPlainObject(item)) fail(`${at} must be an object`)
      const itemId = text(item.id, `${at}.id`, { max: 120 })
      if (itemIds.has(itemId)) fail(`${at}.id "${itemId}" is used by another item`)
      itemIds.add(itemId)
      text(item.material, `${at}.material`, { max: 120 })
      number(item.startSec, `${at}.startSec`, { min: 0 })
      number(item.inSec, `${at}.inSec`, { min: 0 })
      number(item.outSec, `${at}.outSec`, { min: 0 })
      if (item.outSec <= item.inSec) fail(`${at}.outSec must be greater than inSec`)
      number(item.gainDb, `${at}.gainDb`, { min: -120, max: 24 })
      number(item.pan, `${at}.pan`, { min: -1, max: 1 })
      number(item.fadeInSec, `${at}.fadeInSec`, { min: 0 })
      number(item.fadeOutSec, `${at}.fadeOutSec`, { min: 0 })
      flag(item.muted, `${at}.muted`)
      if (typeof item.label !== 'string') fail(`${at}.label must be a string`)
    })
  })

  const duration = contentEndSec(project)
  if (duration > LIMITS.durationSec) {
    fail(`a project may last at most ${LIMITS.durationSec / 60} minutes, this one ends at ${duration.toFixed(1)}s`)
  }
  return project
}

/** Save-time normalization: durationSec is content-derived, never an input (spec §6.2). */
export function stampForSave(project, { by = 'user', note = '' } = {}) {
  const stamped = { ...project, modifiedAt: nowIso(), durationSec: contentEndSec(project) }
  if (note) stamped.history = [...(project.history ?? []), { at: stamped.modifiedAt, by, note }]
  return stamped
}
