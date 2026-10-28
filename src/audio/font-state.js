import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { basename } from 'node:path'

/** True when `target` is `root` itself or lives below it (both already resolved). */
function isInside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Bookkeeping for installed font files: checksums, provenance and verification
 * time. The files themselves are the source of truth for "can I render with it";
 * this state only powers the settings UI (verify / upgrade / delete feedback).
 */
const STATE_VERSION = 1

export function statePath() {
  const explicit = process.env.ANYAUDIO_STATE
  if (explicit && explicit.trim()) return resolve(explicit.trim())
  const override = process.env.ANYAUDIO_CONFIG
  if (override && override.trim()) return join(dirname(override.trim()), 'state.json')
  return join(homedir(), '.dsh', 'anyaudio', 'state.json')
}

function emptyState() {
  return { version: STATE_VERSION, fonts: {} }
}

export async function readState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.fonts !== 'object') return emptyState()
    return { version: STATE_VERSION, fonts: parsed.fonts }
  } catch {
    return emptyState()
  }
}

async function writeState(state) {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export async function recordFont({ path, id = null, name = null, bytes = null, sha256 = null, source = 'unknown', license = null, licenseUrl = null, verified = false }) {
  const state = await readState()
  const previous = state.fonts[path] ?? {}
  state.fonts[path] = {
    id: id ?? previous.id ?? null,
    name: name ?? previous.name ?? basename(path),
    bytes: bytes ?? previous.bytes ?? null,
    sha256: sha256 ?? previous.sha256 ?? null,
    source,
    license: license ?? previous.license ?? null,
    licenseUrl: licenseUrl ?? previous.licenseUrl ?? null,
    installedAt: previous.installedAt ?? new Date().toISOString(),
    verifiedAt: verified ? new Date().toISOString() : previous.verifiedAt ?? null,
    status: verified ? 'ok' : previous.status ?? 'unknown',
  }
  await writeState(state)
  return state.fonts[path]
}

export async function updateFontEntry(path, patch) {
  const state = await readState()
  if (!state.fonts[path]) return null
  state.fonts[path] = { ...state.fonts[path], ...patch }
  await writeState(state)
  return state.fonts[path]
}

export async function forgetFont(path) {
  const state = await readState()
  delete state.fonts[path]
  await writeState(state)
}

/** Merge scan results with recorded state and flag files that changed size. */
export async function describeFonts(fonts) {
  const state = await readState()
  return Promise.all(
    fonts.map(async (font) => {
      const record = state.fonts[font.path] ?? null
      const changed = Boolean(record?.bytes && record.bytes !== font.bytes)
      return {
        ...font,
        id: record?.id ?? null,
        name: record?.name ?? font.name,
        sha256: record?.sha256 ?? null,
        license: record?.license ?? null,
        installedAt: record?.installedAt ?? null,
        verifiedAt: record?.verifiedAt ?? null,
        status: changed ? 'modified' : record?.status ?? 'unmanaged',
        managed: Boolean(record),
      }
    }),
  )
}

/**
 * Delete a font file. Only real files inside the shared font library are
 * touched; the path is resolved (including symlinks and junctions) before the
 * check so neither ".." nor a link pointing elsewhere can escape.
 */
export async function deleteFont(path, { dirs = [] } = {}) {
  const target = String(path ?? '')
  if (!target.trim()) throw new Error('refusing to delete an empty path')
  const declared = resolve(target)
  const resolvedTarget = await realpath(declared).catch(() => null)
  if (!resolvedTarget) throw new Error(`font not found: ${target}`)
  // Resolve the parent too: a junction in the middle of the path (a moved home
  // folder, for example) must still count as "inside", while a path that merely
  // points into the library from outside must not.
  const parent = await realpath(dirname(declared)).catch(() => dirname(declared))
  const locatedAt = join(parent, basename(declared))
  const roots = []
  for (const dir of dirs) {
    if (!dir) continue
    roots.push(await realpath(dir).catch(() => resolve(dir)))
  }
  if (!roots.some((root) => isInside(root, locatedAt))) {
    throw new Error('refusing to delete a font outside the AnyAudio font library')
  }
  if (!roots.some((root) => isInside(root, resolvedTarget))) {
    throw new Error('refusing to delete a font that points outside the AnyAudio font library')
  }
  const info = await stat(resolvedTarget)
  if (!info.isFile()) throw new Error(`refusing to delete a non-file: ${target}`)
  await unlink(declared)
  await forgetFont(target)
  return { deleted: resolvedTarget, bytes: info.size }
}
