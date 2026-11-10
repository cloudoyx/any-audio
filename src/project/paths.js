/**
 * Project folder layout, path resolution and id generation (spec §6.1).
 *
 * Everything the plugin writes lives under one folder per project:
 *
 *   <root>/.anyaudio/projects/<id>/
 *     project.json
 *     materials/index.json
 *     materials/<materialId>.wav
 *     materials/<materialId>.peaks.json
 *     sources/<materialId>.<kind>.json
 *     sources/<materialId>.orig.<ext>
 *     video/<file>
 */
import { randomBytes } from 'node:crypto'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

export const PROJECTS_DIRNAME = '.anyaudio'
export const PROJECTS_SUBDIR = 'projects'
export const PROJECT_FILE = 'project.json'
export const MATERIALS_DIR = 'materials'
export const SOURCES_DIR = 'sources'
export const VIDEO_DIR = 'video'
export const MATERIAL_INDEX = 'materials/index.json'

export class ProjectPathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProjectPathError'
  }
}

/** Root that holds every project of one workspace. */
export function projectsRoot(workspaceRoot) {
  return join(workspaceRoot, PROJECTS_DIRNAME, PROJECTS_SUBDIR)
}

export function projectDir(workspaceRoot, projectId) {
  return join(projectsRoot(workspaceRoot), assertId(projectId, 'project id'))
}

export function projectFile(workspaceRoot, projectId) {
  return join(projectDir(workspaceRoot, projectId), PROJECT_FILE)
}

export function materialsDir(workspaceRoot, projectId) {
  return join(projectDir(workspaceRoot, projectId), MATERIALS_DIR)
}

export function materialIndexFile(workspaceRoot, projectId) {
  return join(projectDir(workspaceRoot, projectId), MATERIAL_INDEX)
}

export function sourcesDir(workspaceRoot, projectId) {
  return join(projectDir(workspaceRoot, projectId), SOURCES_DIR)
}

export function videoDir(workspaceRoot, projectId) {
  return join(projectDir(workspaceRoot, projectId), VIDEO_DIR)
}

export function assertId(value, what = 'id') {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw new ProjectPathError(`${what} is required`)
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new ProjectPathError(`${what} may only contain letters, digits, "-" and "_", got "${raw}"`)
  }
  return raw
}

/**
 * Resolve a relative path from project.json/index.json. Anything that escapes
 * the project folder is refused rather than normalized back inside: the caller
 * asked for something the format does not allow.
 */
export function resolveInside(projectDirPath, relativePath, what = 'path') {
  const raw = typeof relativePath === 'string' ? relativePath.trim() : ''
  if (!raw) throw new ProjectPathError(`${what} is required`)
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new ProjectPathError(`${what} must be relative to the project folder, got "${raw}"`)
  }
  const segments = raw.replace(/\\/g, '/').split('/')
  if (segments.includes('..')) throw new ProjectPathError(`${what} must not escape the project folder, got "${raw}"`)
  const base = resolve(projectDirPath)
  const target = resolve(base, normalize(raw))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ProjectPathError(`${what} must stay inside the project folder, got "${raw}"`)
  }
  return target
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function token(length) {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

export function newProjectId(prefix = 'prj') {
  return `${prefix}_${token(8)}`
}

export function newMaterialId() {
  return `mat_${token(8)}`
}

export function newTrackId() {
  return `trk_${token(6)}`
}

export function newItemId() {
  return `itm_${token(6)}`
}

/** A filesystem-safe folder/file name derived from a human title. */
export function safeName(value, fallback = 'project') {
  const raw = typeof value === 'string' ? value.trim() : ''
  const cleaned = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned.slice(0, 80) : fallback
}
