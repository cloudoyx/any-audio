/**
 * Putting generated material into a project (improvement plan 01, I-10).
 *
 * A tool that only writes a file leaves the person with something they cannot
 * adjust: a single 80-second effects bed cannot have one door slam moved. So the
 * three generating tools take a `projectId` and land their output on a track
 * through here — the file exists twice (project copy + delivered copy), but the
 * arrangement exists once, in `project.json`.
 *
 * Track selection follows spec §5.2: two sounds may share a track only when they
 * never overlap in time. When the requested track is already busy at that moment
 * this walks to the next free one instead of stacking them, because "same
 * category, same moment, same track" is a bug, not a style choice.
 */
import { contentEndSec, LIMITS, TRACK_CATEGORIES } from './schema.js'
import { newItemId, newTrackId } from './paths.js'
import { readProject, saveProject } from './store.js'
import { importGeneratedMaterial } from './import.js'

export class AttachError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AttachError'
  }
}

/** Insert a track when the requested name does not exist yet, and return it. */
export function ensureTrack(project, { name, category = 'other' }) {
  const wanted = String(name ?? '').trim()
  if (!wanted) throw new AttachError('a track name is required')
  const existing = project.tracks.find((track) => track.name === wanted)
  if (existing) return existing
  const resolved = TRACK_CATEGORIES.includes(category) ? category : 'other'
  const track = {
    id: newTrackId(),
    name: wanted,
    category: resolved,
    volumeDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    items: [],
  }
  project.tracks.push(track)
  return track
}

export function placeClip(track, material, { startSec = 0, inSec, outSec, gainDb = 0, pan = 0, fadeInSec = 0, fadeOutSec = 0, label }) {
  const item = {
    id: newItemId(),
    material: material.id,
    startSec: Math.max(0, Number(startSec) || 0),
    inSec: inSec === undefined ? 0 : Number(inSec),
    outSec: outSec === undefined ? material.durationSec : Number(outSec),
    gainDb: Number(gainDb) || 0,
    pan: Number(pan) || 0,
    fadeInSec: Number(fadeInSec) || 0,
    fadeOutSec: Number(fadeOutSec) || 0,
    muted: false,
    label: String(label ?? '').trim() || material.id,
  }
  item.outSec = Math.min(item.outSec, material.durationSec)
  if (!(item.outSec > item.inSec)) {
    throw new AttachError(`clip range ${item.inSec}–${item.outSec}s is empty; the material lasts ${material.durationSec}s`)
  }
  track.items.push(item)
  return item
}

export function itemEndSec(item) {
  return Number(item.startSec) + (Number(item.outSec) - Number(item.inSec))
}

/** Where the next clip on this track would go: right after the last one. */
export function nextFreeStartSec(track) {
  return track.items.reduce((end, item) => Math.max(end, itemEndSec(item)), 0)
}

function overlaps(track, startSec, endSec) {
  return track.items.some((item) => startSec < itemEndSec(item) - 1e-6 && endSec > Number(item.startSec) + 1e-6)
}

/**
 * The tracks that belong to one name family: `环境音`, `环境音 2`, `环境音 3` …,
 * in creation order.
 *
 * This — not a single name — is what "that track" means. The family is how a
 * category spreads over several tracks when its sounds overlap in time, so any
 * code asking "where does the next ambient sound go?" has to see all of them or
 * it will hand back a position on one track while placing the clip on another.
 * Both the auto-append anchor and the free-track search below read it.
 */
export function trackFamily(project, base) {
  const wanted = String(base ?? '').trim()
  if (!wanted) return []
  const out = []
  for (const track of project.tracks) {
    const name = String(track.name ?? '')
    if (name === wanted) { out.push(track); continue }
    const match = /^(.*) (\d+)$/.exec(name)
    if (match && match[1] === wanted && Number(match[2]) >= 2) out.push(track)
  }
  return out
}

/** End of the last clip across a whole family — where an appended clip goes. */
export function familyEndSec(project, base) {
  return trackFamily(project, base).reduce((end, track) => Math.max(end, nextFreeStartSec(track)), 0)
}

/**
 * The first track of this name family that is free for the given span, creating
 * one when the family is full.
 * `环境音` / `环境音 2` / `环境音 3` … — the suffix only appears when needed.
 */
export function freeTrack(project, { name, category, startSec, endSec }) {
  const base = String(name ?? '').trim()
  if (!base) throw new AttachError('a track name is required')
  for (let index = 1; index <= LIMITS.tracks; index++) {
    const candidate = index === 1 ? base : `${base} ${index}`
    const track = project.tracks.find((entry) => entry.name === candidate)
    if (!track) return ensureTrack(project, { name: candidate, category })
    if (!overlaps(track, startSec, endSec)) return track
  }
  throw new AttachError(`no free track for "${base}" at ${startSec.toFixed(2)}s; the project already has ${LIMITS.tracks} tracks`)
}

/**
 * The track a clip with `allowOverlap` belongs on: the first of its family, made
 * when the family is empty.
 *
 * Narration uses this (improvement plan 02, I-03). Two lines of the same voice
 * are the same track even when they touch by a few hundredths of a second: a
 * person who asked for one narrator does not want the fourth line to appear on
 * "旁白 2" because it started 0.22s early. Effects do not use it — two doors at
 * the same instant are two events and must stay separable.
 */
export function overlappingTrack(project, { name, category }) {
  const base = String(name ?? '').trim()
  if (!base) throw new AttachError('a track name is required')
  return trackFamily(project, base)[0] ?? ensureTrack(project, { name: base, category })
}

/**
 * Remove a whole name family, clips and all, so a re-render replaces rather than
 * appends.
 *
 * Regenerating a score to fix its balance is the ordinary case, and it used to
 * leave the old stems behind: `freeTrack` saw the family busy on the same span,
 * opened `钟琴旋律 2`, and the project ended up with two of everything. Eight
 * tracks where four were meant, from a single re-render. Materials are left on
 * disk — a material may be referenced from another track, and deleting files is
 * not an edit of the arrangement.
 */
export function removeTrackFamily(project, base) {
  const family = trackFamily(project, base)
  if (family.length === 0) return []
  const ids = new Set(family.map((track) => track.id))
  const names = family.map((track) => track.name)
  project.tracks = project.tracks.filter((track) => !ids.has(track.id))
  return names
}

function assertWithinLimits(project) {
  const end = contentEndSec(project)
  if (end > LIMITS.durationSec) {
    throw new AttachError(`this would make the project ${end.toFixed(1)}s long; the limit is ${LIMITS.durationSec}s`)
  }
  if (project.tracks.length > LIMITS.tracks) {
    throw new AttachError(`this would make the project ${project.tracks.length} tracks; the limit is ${LIMITS.tracks}`)
  }
}

/**
 * Register one already-written material in the project and place it.
 *
 * `material` is what `importGeneratedMaterial` returned. `autoStart` appends the
 * clip after the last one in its track family, which is what a batch of narration
 * lines or effects wants; anything with an explicit `startSec` keeps it.
 *
 * `allowOverlap` lets a clip share a track with one it touches in time. Only
 * narration asks for it (I-03): the same voice belongs on one track even when two
 * lines overlap by a few hundredths of a second. Effects must not — two doors at
 * the same instant are two separate events.
 */
export async function attachClip(workspaceRoot, projectId, material, {
  trackName,
  category = 'other',
  startSec,
  autoStart = false,
  allowOverlap = false,
  inSec,
  outSec,
  gainDb = 0,
  pan = 0,
  fadeInSec = 0,
  fadeOutSec = 0,
  label,
  note,
} = {}) {
  const project = await readProject(workspaceRoot, projectId)
  const length = (outSec === undefined ? material.durationSec : Number(outSec)) - (inSec === undefined ? 0 : Number(inSec))
  if (!(length > 0)) {
    throw new AttachError(`${material.id}: the clip range ${inSec ?? 0}–${outSec ?? material.durationSec}s is empty`)
  }

  const wantedStart = startSec === undefined ? undefined : Number(startSec)
  // The append anchor spans the whole name family, not one track: otherwise a
  // family that already spread over `音效 · 环境音` and `音效 · 环境音 2` would
  // get its next clip placed at the first track's end, which is behind the
  // second one — and freeTrack would then judge the family busy and open a third.
  const begin = wantedStart ?? (autoStart ? familyEndSec(project, trackName) : 0)
  const track = allowOverlap
    ? overlappingTrack(project, { name: trackName, category })
    : freeTrack(project, { name: trackName, category, startSec: begin, endSec: begin + length })

  const clip = placeClip(track, material, {
    startSec: begin,
    inSec,
    outSec,
    gainDb,
    pan,
    fadeInSec,
    fadeOutSec,
    label: label ?? material.label ?? material.id,
  })
  assertWithinLimits(project)
  await saveProject(workspaceRoot, project, {
    by: 'agent',
    note: note || `放入素材「${clip.label}」到轨道「${track.name}」`,
  })
  return { track, clip }
}

/**
 * Import one generated file and place it. This is the single step every
 * generating tool ends with, so the project copy, the track and the clip are
 * created the same way whichever tool produced the audio.
 */
export async function attachMaterialFile(workspaceRoot, projectId, sourcePath, {
  kind,
  trackName,
  category = 'other',
  snapshot,
  snapshotKind,
  tool,
  label,
  startSec,
  autoStart = false,
  allowOverlap = false,
  inSec,
  outSec,
  gainDb = 0,
  pan = 0,
  fadeInSec = 0,
  fadeOutSec = 0,
  peakDb,
  rmsDb,
  note,
} = {}) {
  const { material } = await importGeneratedMaterial(workspaceRoot, projectId, {
    sourcePath,
    kind,
    snapshotKind,
    snapshot,
    tool,
    label: label ?? trackName,
    // A caller that already measured the samples hands the numbers over instead
    // of making the import walk them again (improvement plan 03, I-36).
    peakDb,
    rmsDb,
  })
  const placed = await attachClip(workspaceRoot, projectId, material, {
    trackName,
    category,
    startSec,
    autoStart,
    allowOverlap,
    inSec,
    outSec,
    gainDb,
    pan,
    fadeInSec,
    fadeOutSec,
    label,
    note,
  })
  return {
    materialId: material.id,
    file: material.file,
    durationSec: material.durationSec,
    trackId: placed.track.id,
    trackName: placed.track.name,
    clipId: placed.clip.id,
    startSec: placed.clip.startSec,
  }
}
