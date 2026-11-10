/**
 * project.json in, project.json out (plan M5.1).
 *
 * The editor keeps a richer object in memory than the file holds, so every save
 * must go through this function: it names each field explicitly instead of
 * spreading, which is what stops view state from ever reaching the disk and what
 * makes a newly added schema field fail loudly in the test rather than vanish.
 *
 * Deliberately dependency-free: the test evaluates this file on its own, and the
 * rule it enforces ("no field reaches the disk by accident") is easier to trust
 * when there is nothing else it could be pulling in.
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
    // An empty chain is omitted rather than written as []: a project without
    // effects then looks exactly like one written before the field existed, and
    // the diff of a save that only moved a clip stays about the clip.
    ...(project.masterFx?.length ? { masterFx: serializeChain(project.masterFx) } : {}),
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
        ...(item.fx?.length ? { fx: serializeChain(item.fx) } : {}),
      })),
    })),
  }
}

/**
 * One chain, field by field, with no import at all.
 *
 * The point of naming every field is that a field added later has to be added
 * here on purpose — the same rule the rest of this file follows. It stays
 * dependency-free so the test can evaluate this module on its own: the rule
 * "nothing reaches the disk by accident" is easier to trust when there is
 * nothing else this file could be pulling in.
 *
 * Defaults are *not* filled in here. Writing them would freeze today's defaults
 * into every file, so a project saved now would stop following a later change to
 * how an effect is meant to sound; leaving the sparse form lets `resolveFx` in
 * `src/audio/fx.js` be the one place defaults live.
 */
function serializeChain(chain) {
  return (chain ?? []).map((fx) => {
    const out = { type: fx.type }
    if (Array.isArray(fx.bands)) {
      out.bands = fx.bands.map((band) => ({
        type: band.type,
        freqHz: band.freqHz,
        gainDb: band.gainDb,
        q: band.q,
      }))
    }
    for (const field of FX_SCALAR_FIELDS) {
      if (fx[field] !== undefined) out[field] = fx[field]
    }
    return out
  })
}

/** Every scalar an effect can carry; `type` and `bands` are handled above. */
const FX_SCALAR_FIELDS = [
  'sourceTrackId', 'ceilingDb', 'thresholdDb', 'ratio', 'attackSec', 'releaseSec',
  'kneeDb', 'makeupDb', 'roomSize', 'damping', 'wet', 'dry', 'width', 'timeSec',
  'feedback', 'pingPong', 'targetDb', 'rate', 'pitchSemitones', 'preservePitch',
]

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
