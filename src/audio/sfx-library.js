/**
 * The sound-effect library: which packs are installed on this machine, what
 * each one contains, and how a name the agent typed resolves to one sound.
 *
 * Two levels live here and must not be confused:
 *
 * - a **pack** is installed once under `~/.dsh/anyaudio/sfx/<packId>/` and is
 *   shared by every project on the machine;
 * - a **project material** is the single sound that was actually placed on a
 *   timeline, and it lives inside that project's `materials/` folder.
 *
 * This module only knows about packs. Nothing here writes to a project.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { normalizeManifest, SfxManifestError, validatePackId } from './sfx-manifest.js'

export class SfxLibraryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SfxLibraryError'
  }
}

/**
 * The shared pack library: one directory per machine account, used by every
 * project and every agent session. Same idea as `userFontDir()`.
 */
export function userSfxDir() {
  const override = process.env.ANYAUDIO_SFX_DIR
  if (override && override.trim()) return resolve(override.trim())
  return join(homedir(), '.dsh', 'anyaudio', 'sfx')
}

async function readManifestFile(dir) {
  const path = join(dir, 'manifest.json')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new SfxManifestError(`manifest.json could not be read: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new SfxManifestError(`manifest.json is not valid JSON: ${error.message}`)
  }
}

/**
 * Read one pack directory. Returns `null` when the directory holds no manifest
 * at all — that is a normal thing to find (a half-copied folder, a stray
 * directory) and is reported by the caller as a warning, not an error.
 */
export async function readPack(dir, { packId } = {}) {
  const raw = await readManifestFile(dir)
  if (raw === null) return null
  const { manifest, warnings } = normalizeManifest(raw, { packId })
  return { ...manifest, dir, warnings }
}

/**
 * Every installed pack, in directory order. A pack that cannot be read is
 * skipped with a warning: one broken pack must not hide the others.
 */
export async function listPacks({ root = userSfxDir() } = {}) {
  const packs = []
  const warnings = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { root, packs, warnings }
    throw new SfxLibraryError(`the sound library at ${root} could not be listed: ${error.message}`)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    let pack
    try {
      pack = await readPack(dir, { packId: entry.name })
    } catch (error) {
      warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}; the pack was skipped`)
      continue
    }
    if (!pack) {
      warnings.push(`${entry.name}: no manifest.json; the directory was skipped`)
      continue
    }
    if (pack.id !== entry.name) {
      warnings.push(`${entry.name}: manifest.id is "${pack.id}"; the pack is addressed as "${pack.id}"`)
    }
    packs.push(pack)
    for (const warning of pack.warnings) warnings.push(`${pack.id}: ${warning}`)
  }
  return { root, packs, warnings }
}

/** Every sound across every pack, each carrying the pack it came from. */
export function allSounds(packs) {
  const out = []
  for (const pack of packs) for (const sound of pack.sounds) out.push({ ...sound, pack })
  return out
}

export function findPack(packs, packId) {
  return packs.find((pack) => pack.id === packId) ?? null
}

/**
 * How close two names are, for "did you mean" only. Shared characters over the
 * longer name, plus a bonus when one contains the other — enough to put
 * `门-木门-敲门` next to `门-木门-敲门-三下` without pretending to be a search.
 */
function similarity(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const counts = new Map()
  for (const char of a) counts.set(char, (counts.get(char) ?? 0) + 1)
  let shared = 0
  for (const char of b) {
    const left = counts.get(char) ?? 0
    if (left > 0) {
      shared++
      counts.set(char, left - 1)
    }
  }
  const base = shared / Math.max(a.length, b.length)
  const contains = a.includes(b) || b.includes(a) ? 0.25 : 0
  return base + contains
}

/** The closest names to `name`, best first. Used only in error messages. */
export function nearestNames(name, candidates, limit = 3) {
  return [...new Set(candidates)]
    .map((candidate) => ({ candidate, score: similarity(name, candidate) }))
    .filter((entry) => entry.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

function installedList(packs) {
  return packs.length ? packs.map((pack) => pack.id).join(', ') : '(none)'
}

/**
 * Resolve a name the agent typed to exactly one sound.
 *
 * The rules are fixed, because a name is the only handle there is:
 *
 * - a bare name that is unique across the machine resolves;
 * - a bare name that appears in more than one pack is a **conflict**, never a
 *   silent pick — the error lists every `pack/name` so the caller can choose;
 * - `pack/name` addresses one sound exactly, and the two halves fail with
 *   different messages so the caller knows which half was wrong.
 */
export function resolveSound(packs, rawName) {
  const name = String(rawName ?? '')
  if (!name) throw new SfxLibraryError('a sound name is required')

  const slash = name.indexOf('/')
  if (slash >= 0) {
    const packId = name.slice(0, slash)
    const soundName = name.slice(slash + 1)
    const pack = findPack(packs, packId)
    if (!pack) {
      throw new SfxLibraryError(`there is no sound pack "${packId}". Installed packs: ${installedList(packs)}`)
    }
    if (!soundName) throw new SfxLibraryError(`"${name}" names a pack but no sound; write it as "${packId}/<sound name>"`)
    const sound = pack.sounds.find((entry) => entry.name === soundName)
    if (!sound) {
      const near = nearestNames(soundName, pack.sounds.map((entry) => entry.name))
      throw new SfxLibraryError(
        `pack "${packId}" has no sound named "${soundName}"${near.length ? `; closest: ${near.join(', ')}` : ''}`,
      )
    }
    return { sound: { ...sound, packId: pack.id }, pack }
  }

  const matches = []
  for (const pack of packs) {
    const sound = pack.sounds.find((entry) => entry.name === name)
    if (sound) matches.push({ sound: { ...sound, packId: pack.id }, pack })
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    const candidates = matches.map((match) => `${match.pack.id}/${match.sound.name}`).join(', ')
    throw new SfxLibraryError(
      `the name "${name}" exists in more than one pack (${candidates}); address it as "pack/name" to say which one`,
    )
  }
  const near = nearestNames(name, allSounds(packs).map((entry) => entry.name))
  throw new SfxLibraryError(
    `no sound named "${name}" in the library${near.length ? `; closest: ${near.join(', ')}` : ''}`,
  )
}

/**
 * Find sounds by name across every installed pack.
 *
 * The rule is one line: a name that contains the query is a hit, wherever the
 * query sits. No stemming, no synonyms, no tags — the names were written by a
 * person and the agent reads them, so the only job here is to not lose a hit.
 *
 * Ordering only decides who comes first, never who appears: an exact name, then
 * a hit at a segment boundary, then a hit earlier in the name, then the closer
 * duration. Returning 30 names the agent can read beats returning 0 because the
 * ranking was strict.
 */
export function search(packs, { query, type, limit = 30, packsConfig } = {}) {
  const text = String(query ?? '').trim()
  if (!text) throw new SfxLibraryError('a search query is required')
  const wantedType = type ? String(type) : null
  if (wantedType && !['foley', 'ambience', 'dsn'].includes(wantedType)) {
    throw new SfxLibraryError(`unknown sound type "${wantedType}"; expected foley, ambience or dsn`)
  }

  const hits = []
  for (const pack of packs) {
    for (const sound of pack.sounds) {
      if (wantedType && sound.type !== wantedType) continue
      const at = sound.name.indexOf(text)
      if (at < 0) continue
      const segments = sound.name.split('-')
      const wholeSegment = segments.includes(text)
      const startsSegment = segments.some((segment) => segment.startsWith(text))
      hits.push({
        name: sound.name,
        packId: pack.id,
        packName: pack.name,
        type: sound.type,
        durationSec: sound.durationSec,
        priority: isPriorityPack(packsConfig, pack.id),
        score: (sound.name === text ? 8 : 0)
          + (wholeSegment ? 4 : 0)
          + (startsSegment ? 2 : 0)
          + (at === 0 ? 1 : 0),
        at,
      })
    }
  }

  hits.sort((a, b) => b.score - a.score || a.at - b.at || a.durationSec - b.durationSec || a.name.localeCompare(b.name))
  const total = hits.length
  const shown = hits.slice(0, Math.max(1, Number(limit) || 30))
  return {
    query: text,
    total,
    shown: shown.length,
    truncated: total > shown.length,
    results: shown.map(({ score, at, ...rest }) => rest),
  }
}

/** A pack's directory must exist and be a directory before it can be installed. */
export async function assertPackDir(dir) {
  const info = await stat(dir).catch(() => null)
  if (!info?.isDirectory()) throw new SfxLibraryError(`"${dir}" is not a directory`)
  return dir
}

/**
 * Whether a pack is expanded in `catalog` or only summarised there.
 *
 * The stored map holds only what the person changed; everything else falls back
 * to a fixed default. That is why the map is an object and not a list of
 * priority ids: a list cannot tell "never touched" from "explicitly set to
 * normal", so switching the base pack to normal would silently switch it back.
 */
export const DEFAULT_PRIORITY_PACK = 'BaseSFX'

export function packPriority(packsConfig, packId) {
  const explicit = packsConfig?.[packId]
  if (explicit === 'priority' || explicit === 'normal') return explicit
  return packId === DEFAULT_PRIORITY_PACK ? 'priority' : 'normal'
}

export function isPriorityPack(packsConfig, packId) {
  return packPriority(packsConfig, packId) === 'priority'
}

export { validatePackId }
