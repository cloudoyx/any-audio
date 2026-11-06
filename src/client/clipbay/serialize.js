/**
 * project.json in, project.json out (plan M5.1).
 *
 * The editor keeps a richer object in memory than the file holds, so every save
 * must go through this function: it names each field explicitly instead of
 * spreading, which is what stops view state from ever reaching the disk and what
 * makes a newly added schema field fail loudly in the test rather than vanish.
 */
export function serializeProject(project) {
  return {
    schemaVersion: project.schemaVersion,
    id: project.id,
    name: project.name,
    sampleRate: project.sampleRate,
    durationSec: project.durationSec,
    normalizeGainDb: project.normalizeGainDb,
    masterFaderDb: project.masterFaderDb,
    createdAt: project.createdAt,
    modifiedAt: project.modifiedAt,
    history: (project.history ?? []).map((entry) => ({ at: entry.at, by: entry.by, note: entry.note })),
    video: project.video
      ? { path: project.video.path, durationSec: project.video.durationSec, locked: project.video.locked }
      : null,
    tracks: (project.tracks ?? []).map((track) => ({
      id: track.id,
      name: track.name,
      category: track.category,
      volumeDb: track.volumeDb,
      pan: track.pan,
      muted: track.muted,
      solo: track.solo,
      items: (track.items ?? []).map((item) => ({
        id: item.id,
        material: item.material,
        startSec: item.startSec,
        inSec: item.inSec,
        outSec: item.outSec,
        gainDb: item.gainDb,
        pan: item.pan,
        fadeInSec: item.fadeInSec,
        fadeOutSec: item.fadeOutSec,
        muted: item.muted,
        label: item.label,
      })),
    })),
  }
}

/** Length of one clip on the timeline, derived from its source range. */
export function itemLengthSec(item) {
  return Math.max(0, Number(item?.outSec) - Number(item?.inSec))
}

/** Where the last thing on the timeline ends; a longer video wins (mirrors schema.js). */
export function contentEndSec(project) {
  let end = 0
  for (const track of project?.tracks ?? []) {
    for (const item of track?.items ?? []) {
      const start = Number(item?.startSec)
      const length = itemLengthSec(item)
      if (Number.isFinite(start) && Number.isFinite(length)) end = Math.max(end, start + length)
    }
  }
  const video = Number(project?.video?.durationSec)
  if (Number.isFinite(video)) end = Math.max(end, video)
  return Number(end.toFixed(6))
}
