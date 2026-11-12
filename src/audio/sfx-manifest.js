/**
 * Sound-effect pack manifest: the field definitions and the validation rules.
 *
 * A pack is a directory with one `manifest.json` and the audio files it names.
 * The manifest is the only thing the library reads; the audio is opened only
 * when a sound is actually placed on a timeline.
 *
 * Kept apart from `src/project/schema.js` on purpose: that one validates a
 * project file, this one validates a pack. They share no fields and change for
 * different reasons.
 */

export const SFX_MANIFEST_SCHEMA_VERSION = 1

/** The three kinds a sound can be. Anything else is skipped, not guessed. */
export const SFX_SOUND_TYPES = ['foley', 'ambience', 'dsn']

/** Types that carry a main-peak position. Ambience is chosen by scene, not shape. */
export const SFX_PEAK_TYPES = ['foley', 'dsn']

export class SfxManifestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SfxManifestError'
  }
}

/**
 * A name is a handle the agent types back, so the rules are deliberately thin:
 * only what would make addressing ambiguous is refused.
 *
 * `/` separates `pack/sound`, so it cannot appear inside either half. Leading
 * and trailing whitespace is invisible and would make two names that look the
 * same compare unequal. Everything else — full-width punctuation, spaces in the
 * middle, `_`, emoji — is allowed, because a person naming their own recordings
 * should not have to learn a character set first.
 */
export function validateSoundName(name, path = 'name') {
  if (typeof name !== 'string') throw new SfxManifestError(`${path} must be a string`)
  if (!name) throw new SfxManifestError(`${path} must not be empty`)
  if (name.includes('/')) throw new SfxManifestError(`${path} "${name}" must not contain "/" (it separates pack from sound)`)
  if (name !== name.trim()) throw new SfxManifestError(`${path} "${name}" must not start or end with whitespace`)
  return name
}

export function validatePackId(id, path = 'id') {
  if (typeof id !== 'string') throw new SfxManifestError(`${path} must be a string`)
  if (!id) throw new SfxManifestError(`${path} must not be empty`)
  if (id.includes('/')) throw new SfxManifestError(`${path} "${id}" must not contain "/"`)
  if (id !== id.trim()) throw new SfxManifestError(`${path} "${id}" must not start or end with whitespace`)
  if (id === '.' || id === '..') throw new SfxManifestError(`${path} "${id}" is not a usable directory name`)
  return id
}

/**
 * A pack-relative path. Backslashes are accepted and normalised because a
 * manifest written on Windows is a normal thing to receive; `..` and absolute
 * paths are refused because a pack must not reach outside its own directory.
 */
export function normalizePackFile(file, path = 'file') {
  if (typeof file !== 'string' || !file.trim()) throw new SfxManifestError(`${path} must be a non-empty string`)
  const normalized = file.trim().replace(/\\/g, '/')
  if (normalized.startsWith('/')) throw new SfxManifestError(`${path} "${file}" must be relative to the pack directory`)
  if (/^[A-Za-z]:/.test(normalized)) throw new SfxManifestError(`${path} "${file}" must be relative to the pack directory`)
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) throw new SfxManifestError(`${path} "${file}" must not leave the pack directory`)
  if (segments.some((segment) => segment === '')) throw new SfxManifestError(`${path} "${file}" has an empty path segment`)
  return normalized
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

/**
 * Turn one raw manifest into the shape the library uses.
 *
 * Pack-level problems throw: a manifest that cannot be trusted is not half
 * loaded. Entry-level problems are collected as warnings and the entry is
 * dropped, so one bad row does not cost the other 445.
 */
export function normalizeManifest(raw, { packId } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SfxManifestError('manifest must be a JSON object')
  }
  const warnings = []

  const id = validatePackId(raw.id ?? packId, 'manifest.id')
  if (packId !== undefined && raw.id !== undefined && raw.id !== packId) {
    warnings.push(`manifest.id "${raw.id}" differs from the directory name "${packId}"; the manifest wins`)
  }

  const schemaVersion = Number(raw.schemaVersion ?? SFX_MANIFEST_SCHEMA_VERSION)
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1) {
    throw new SfxManifestError(`manifest.schemaVersion must be a positive number, got ${JSON.stringify(raw.schemaVersion)}`)
  }
  if (schemaVersion > SFX_MANIFEST_SCHEMA_VERSION) {
    warnings.push(`manifest.schemaVersion ${schemaVersion} is newer than ${SFX_MANIFEST_SCHEMA_VERSION}; unknown fields are ignored`)
  }

  if (!Array.isArray(raw.sounds)) throw new SfxManifestError('manifest.sounds must be an array')

  const sounds = []
  const seen = new Set()
  for (const [index, entry] of raw.sounds.entries()) {
    const where = `sounds[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`${where} is not an object; skipped`)
      continue
    }
    // A name that cannot be addressed is a pack-level fault, not a bad row:
    // every other entry would still be reachable, but the pack as a whole was
    // written against rules the library cannot honour. Fail it loudly.
    const name = validateSoundName(entry.name, `${where}.name`)
    if (seen.has(name)) {
      throw new SfxManifestError(`duplicate sound name "${name}" in pack "${id}"`)
    }
    if (!SFX_SOUND_TYPES.includes(entry.type)) {
      warnings.push(`${where} "${name}" has unknown type ${JSON.stringify(entry.type)}; skipped (expected ${SFX_SOUND_TYPES.join(' / ')})`)
      continue
    }
    const durationSec = positiveNumber(entry.durationSec)
    if (durationSec === null) {
      warnings.push(`${where} "${name}" has no usable durationSec; skipped`)
      continue
    }
    let file
    try {
      file = normalizePackFile(entry.file, `${where}.file`)
    } catch (error) {
      warnings.push(`${error.message}; skipped`)
      continue
    }
    const peakPosSec = positiveNumber(entry.peakPosSec)
    if (peakPosSec === null && SFX_PEAK_TYPES.includes(entry.type)) {
      warnings.push(`${where} "${name}" has no peakPosSec; the waveform is the only shape hint for it`)
    }
    seen.add(name)
    sounds.push({
      name,
      type: entry.type,
      durationSec,
      ...(peakPosSec === null ? {} : { peakPosSec: Math.min(peakPosSec, durationSec) }),
      file,
      packId: id,
    })
  }

  return {
    manifest: {
      schemaVersion,
      id,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
      version: typeof raw.version === 'string' ? raw.version.trim() : '',
      license: typeof raw.license === 'string' ? raw.license.trim() : '',
      format: typeof raw.format === 'string' && raw.format.trim() ? raw.format.trim().toLowerCase() : 'mp3',
      sounds,
    },
    warnings,
  }
}
