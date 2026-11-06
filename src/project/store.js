/**
 * Reading, writing and listing projects.
 *
 * Writes go through a temporary file plus rename so a crash mid-write cannot
 * leave a half-written project.json (plan M0). No lock and no version check:
 * the product rule is a single writer at a time (spec §9.2).
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyProject, migrate, stampForSave, validateProject, ProjectSchemaError } from './schema.js'
import {
  MATERIAL_INDEX,
  materialsDir,
  newProjectId,
  projectDir as projectDirOf,
  projectFile,
  projectsRoot,
  safeName,
  sourcesDir,
  videoDir,
} from './paths.js'

export class ProjectStoreError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProjectStoreError'
  }
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function readJson(path) {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ProjectStoreError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function emptyMaterialIndex() {
  return { materials: [] }
}

/**
 * Create the folder skeleton and write the initial project.json/index.json.
 * `name` is a display title; the folder uses the generated id so renaming a
 * project never moves files on disk.
 */
export async function createProject(workspaceRoot, { name, id, sampleRate = 48000, by = 'agent', note = 'created' } = {}) {
  if (!workspaceRoot) throw new ProjectStoreError('a workspace root is required to create a project')
  const projectId = id ? safeName(id, 'prj') : newProjectId()
  const dir = projectDirOf(workspaceRoot, projectId)
  if (existsSync(dir)) throw new ProjectStoreError(`project "${projectId}" already exists at ${dir}`)
  const title = typeof name === 'string' && name.trim() ? name.trim() : projectId

  const project = emptyProject({ id: projectId, name: title, sampleRate })
  project.history = [{ at: project.createdAt, by, note }]
  validateProject(project)

  await mkdir(materialsDir(workspaceRoot, projectId), { recursive: true })
  await mkdir(sourcesDir(workspaceRoot, projectId), { recursive: true })
  await atomicWriteJson(projectFile(workspaceRoot, projectId), project)
  await atomicWriteJson(join(dir, MATERIAL_INDEX), emptyMaterialIndex())
  return project
}

export async function readProject(workspaceRoot, projectId) {
  const path = projectFile(workspaceRoot, projectId)
  let raw
  try {
    raw = await readJson(path)
  } catch (error) {
    if (error instanceof ProjectStoreError) throw error
    throw new ProjectStoreError(`cannot read project "${projectId}": ${error.code === 'ENOENT' ? 'no such project' : error.message}`)
  }
  const migrated = migrate(raw)
  return validateProject(migrated)
}

/** Validate, stamp modifiedAt/durationSec, append a history entry, write atomically. */
export async function saveProject(workspaceRoot, project, { by = 'user', note = '' } = {}) {
  const stamped = stampForSave(project, { by, note })
  validateProject(stamped)
  await atomicWriteJson(projectFile(workspaceRoot, stamped.id), stamped)
  return stamped
}

export async function readMaterialIndex(workspaceRoot, projectId) {
  const path = join(projectDirOf(workspaceRoot, projectId), MATERIAL_INDEX)
  try {
    const raw = await readJson(path)
    return Array.isArray(raw?.materials) ? raw : emptyMaterialIndex()
  } catch (error) {
    if (error instanceof ProjectStoreError) throw error
    if (error.code === 'ENOENT') return emptyMaterialIndex()
    throw error
  }
}

export async function writeMaterialIndex(workspaceRoot, projectId, index) {
  const value = { materials: Array.isArray(index?.materials) ? index.materials : [] }
  await atomicWriteJson(join(projectDirOf(workspaceRoot, projectId), MATERIAL_INDEX), value)
  return value
}

/** Projects in one workspace, newest first. A broken folder is skipped, not fatal. */
export async function listProjects(workspaceRoot) {
  const root = projectsRoot(workspaceRoot)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const project = await readProject(workspaceRoot, entry.name)
      const info = await stat(projectFile(workspaceRoot, entry.name))
      rows.push({
        id: project.id,
        name: project.name,
        durationSec: project.durationSec,
        trackCount: project.tracks.length,
        hasVideo: Boolean(project.video),
        modifiedAt: project.modifiedAt,
        mtimeMs: info.mtimeMs,
      })
    } catch {
      // a folder that no longer holds a valid project must not hide the others
    }
  }
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export async function projectExists(workspaceRoot, projectId) {
  try {
    const info = await stat(projectFile(workspaceRoot, projectId))
    return info.isFile()
  } catch {
    return false
  }
}

export { ProjectSchemaError }
