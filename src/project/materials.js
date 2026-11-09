/**
 * Material registry: the index is the "what is this and where did it come from"
 * half of the pair (spec §6.4). It never stores arrangement, and references are
 * counted from project.json on demand — a separate counter would be a second
 * source of truth that drifts.
 */
import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { assertRelativePath, MATERIAL_KINDS, ProjectSchemaError } from './schema.js'
import {
  MATERIALS_DIR,
  materialsDir,
  newMaterialId,
  projectDir as projectDirOf,
  resolveInside,
  SOURCES_DIR,
} from './paths.js'
import { readMaterialIndex, readProject, writeMaterialIndex } from './store.js'

export class MaterialError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MaterialError'
  }
}

export function findMaterial(index, materialId) {
  return (index?.materials ?? []).find((entry) => entry.id === materialId) ?? null
}

export function validateMaterial(entry, path = 'material') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ProjectSchemaError(`${path} must be an object`)
  if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(entry.id)) {
    throw new ProjectSchemaError(`${path}.id may only contain letters, digits, "-" and "_"`)
  }
  assertRelativePath(entry.file, `${path}.file`)
  if (typeof entry.durationSec !== 'number' || !(entry.durationSec > 0)) {
    throw new ProjectSchemaError(`${path}.durationSec must be a positive number`)
  }
  if (!MATERIAL_KINDS.includes(entry.kind)) {
    throw new ProjectSchemaError(`${path}.kind must be one of ${MATERIAL_KINDS.join(' | ')}`)
  }
  // A material's level is part of its identity, next to its length (improvement
  // plan 03, I-37). Both are optional because every material registered before
  // this existed has neither, and a project must still open: a missing value
  // means "not measured yet", never "silent".
  for (const field of ['peakDb', 'rmsDb']) {
    const value = entry[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ProjectSchemaError(`${path}.${field} must be a finite number or null`)
    }
  }
  if (entry.source && typeof entry.source === 'object' && entry.source.snapshot !== undefined) {
    assertRelativePath(entry.source.snapshot, `${path}.source.snapshot`)
  }
  return entry
}

/**
 * Register a material that already exists in `materials/`. Returns the stored
 * entry; an id collision is an error rather than an overwrite.
 */
export async function registerMaterial(workspaceRoot, projectId, entry) {
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const record = validateMaterial({ ...entry, id: entry.id ?? newMaterialId() })
  if (findMaterial(index, record.id)) {
    throw new MaterialError(`material "${record.id}" already exists in project "${projectId}"`)
  }
  index.materials.push(record)
  await writeMaterialIndex(workspaceRoot, projectId, index)
  return record
}

export async function updateMaterial(workspaceRoot, projectId, materialId, patch) {
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const existing = findMaterial(index, materialId)
  if (!existing) throw new MaterialError(`material "${materialId}" is not in project "${projectId}"`)
  const merged = validateMaterial({ ...existing, ...patch, id: existing.id })
  index.materials = index.materials.map((row) => (row.id === materialId ? merged : row))
  await writeMaterialIndex(workspaceRoot, projectId, index)
  return merged
}

export async function removeMaterialRecord(workspaceRoot, projectId, materialId) {
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const next = index.materials.filter((row) => row.id !== materialId)
  if (next.length === index.materials.length) throw new MaterialError(`material "${materialId}" is not in project "${projectId}"`)
  index.materials = next
  await writeMaterialIndex(workspaceRoot, projectId, index)
  return true
}

/** Every item in the project pointing at this material, with its track. */
export function referencesFor(project, materialId) {
  const rows = []
  for (const track of project?.tracks ?? []) {
    for (const item of track?.items ?? []) {
      if (item.material === materialId) rows.push({ trackId: track.id, trackName: track.name, itemId: item.id, label: item.label })
    }
  }
  return rows
}

/**
 * Delete a material only when nothing references it. Deleting an item never
 * touches the material (spec §6.5): the same material can be used twice.
 */
export async function deleteMaterial(workspaceRoot, projectId, materialId, { deleteFiles = true } = {}) {
  const project = await readProject(workspaceRoot, projectId)
  const used = referencesFor(project, materialId)
  if (used.length > 0) {
    const plural = used.length === 1 ? 'clip' : 'clips'
    throw new MaterialError(`this material is still used by ${used.length} ${plural}; remove those clips first`)
  }
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const entry = findMaterial(index, materialId)
  if (!entry) throw new MaterialError(`material "${materialId}" is not in project "${projectId}"`)

  if (deleteFiles) {
    const dir = projectDirOf(workspaceRoot, projectId)
    await rm(resolveInside(dir, entry.file), { force: true })
    await rm(resolveInside(dir, `${MATERIALS_DIR}/${materialId}.peaks.json`), { force: true })
    const sources = resolveInside(dir, SOURCES_DIR)
    if (existsSync(sources)) {
      for (const name of await readdir(sources)) {
        if (name.startsWith(`${materialId}.`)) await rm(resolveInside(dir, `${SOURCES_DIR}/${name}`), { force: true })
      }
    }
  }
  await removeMaterialRecord(workspaceRoot, projectId, materialId)
  return { deleted: true, materialId, usedBefore: 0 }
}

/** Absolute path of a registered material file, with an existence check. */
export async function materialPath(workspaceRoot, projectId, materialId) {
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const entry = findMaterial(index, materialId)
  if (!entry) throw new MaterialError(`material "${materialId}" is not in project "${projectId}"`)
  const path = resolveInside(projectDirOf(workspaceRoot, projectId), entry.file)
  await stat(path)
  return path
}

export { materialsDir, SOURCES_DIR }
