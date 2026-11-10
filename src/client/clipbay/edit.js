/**
 * Clip editing operations (plan M5.4).
 *
 * Every function takes a project, mutates nothing, and returns a new project plus
 * a human sentence for `history`. Keeping them pure means the same code can be
 * replayed for undo (M5.6) and checked without a DOM.
 *
 * Two rules from spec §8.2 shape all of this:
 *   ① moving a clip never moves its neighbours (no ripple);
 *   ② an agent replacing a range fills that range exactly — implemented in M6,
 *      but the helpers here (split, trim) are what it will call.
 *
 * Times are seconds, gains are dB, pan is -1..1. Nothing here clamps a value the
 * schema would reject: it throws, because a silent clamp hides a bug in the UI.
 */
import { FX_TYPES } from '../../audio/fx.js'

export class EditError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EditError'
  }
}

function clone(project) {
  return structuredClone(project)
}

function findTrack(project, trackId) {
  const track = (project.tracks ?? []).find((entry) => entry.id === trackId)
  if (!track) throw new EditError(`no such track: ${trackId}`)
  return track
}

function findItem(track, itemId) {
  const item = (track.items ?? []).find((entry) => entry.id === itemId)
  if (!item) throw new EditError(`no such clip: ${itemId}`)
  return item
}

export function itemLength(item) {
  return Math.max(0, Number(item.outSec) - Number(item.inSec))
}

/** Ids the schema accepts: letters, digits, "-" and "_". */
export function newId(prefix) {
  const bytes = new Uint8Array(6)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  const suffix = Array.from(bytes, (byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 8)
  return `${prefix}_${suffix}`
}

export function itemEnd(item) {
  return Number(item.startSec) + itemLength(item)
}

/** Round away float noise so a drag does not write 2.0000000000000004. */
function tidy(value) {
  return Number(Number(value).toFixed(6))
}

/**
 * Move one clip. Its length and source range are untouched, and nothing else on
 * the track moves (spec §8.2 ①).
 */
export function moveClip(project, { trackId, itemId, startSec }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const target = Math.max(0, Number(startSec) || 0)
  if (tidy(target) === tidy(item.startSec)) return { project: next, note: '' }
  item.startSec = tidy(target)
  return { project: next, note: `移动片段「${item.label || item.id}」到 ${item.startSec.toFixed(2)}s` }
}

/**
 * Trim by moving one edge. Dragging the left edge keeps the audio in place on the
 * timeline (the in point and the start move together), which is what every DAW
 * does; dragging the right edge only changes the out point.
 */
export function trimClip(project, { trackId, itemId, edge, deltaSec, minLengthSec = 0.05 }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const delta = Number(deltaSec) || 0
  if (delta === 0) return { project: next, note: '' }

  if (edge === 'start') {
    const maxIn = Math.max(0, item.outSec - minLengthSec)
    const nextIn = Math.min(maxIn, Math.max(0, item.inSec + delta))
    const applied = nextIn - item.inSec
    if (Math.abs(applied) < 1e-9) return { project: next, note: '' }
    item.inSec = tidy(nextIn)
    item.startSec = tidy(Math.max(0, item.startSec + applied))
  } else if (edge === 'end') {
    const minOut = item.inSec + minLengthSec
    const nextOut = Math.max(minOut, item.outSec + delta)
    if (Math.abs(nextOut - item.outSec) < 1e-9) return { project: next, note: '' }
    item.outSec = tidy(nextOut)
  } else {
    throw new EditError(`unknown trim edge: ${edge}`)
  }
  return { project: next, note: `裁剪片段「${item.label || item.id}」` }
}

/**
 * Split one clip at an absolute timeline position.
 *
 * The left half keeps the id (so anything holding the id still points at audio),
 * the right half gets a new id. A split exactly on either edge is a no-op rather
 * than a zero-length clip.
 */
export function splitClip(project, { trackId, itemId, atSec, newItemId = newId('itm') }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const at = Number(atSec) || 0
  const left = item.startSec
  const right = itemEnd(item)
  if (!(at > left + 1e-6) || !(at < right - 1e-6)) {
    return { project: next, note: '' }
  }

  const offset = at - left
  const rightHalf = {
    ...structuredClone(item),
    id: newItemId,
    startSec: tidy(at),
    inSec: tidy(item.inSec + offset),
    fadeInSec: 0,
  }
  item.outSec = tidy(item.inSec + offset)
  // The left half keeps the fade-in, the right half keeps the fade-out, so the
  // pair sounds exactly like the original when played back to back.
  item.fadeOutSec = 0

  track.items.push(rightHalf)
  return { project: next, note: `在 ${at.toFixed(2)}s 分割片段「${item.label || item.id}」` }
}

/** Remove a clip. The material and its file are untouched (spec §6.5). */
export function deleteClip(project, { trackId, itemId }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  track.items = track.items.filter((entry) => entry.id !== itemId)
  return { project: next, note: `删除片段「${item.label || item.id}」` }
}

/**
 * Duplicate a clip immediately after itself. The copy gets a fresh id and lands
 * at the original's end, so Ctrl+D on a drum loop lays down the next bar.
 */
export function duplicateClip(project, { trackId, itemId, newItemId = newId('itm') }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const copy = { ...structuredClone(item), id: newItemId, startSec: tidy(itemEnd(item)) }
  track.items.push(copy)
  return { project: next, note: `复制片段「${item.label || item.id}」` }
}

/** Per-clip gain. The renderer adds it to the track fader; nothing is rescaled. */
export function setClipGain(project, { trackId, itemId, gainDb }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const value = Number(gainDb)
  if (!Number.isFinite(value)) throw new EditError('gain must be a number')
  if (value < -120 || value > 24) throw new EditError('gain must stay between -120 and +24 dB')
  if (tidy(value) === tidy(item.gainDb)) return { project: next, note: '' }
  item.gainDb = tidy(value)
  return { project: next, note: `调整片段「${item.label || item.id}」增益 ${item.gainDb} dB` }
}

/** Per-clip pan, summed with the track pan by the renderer. */
export function setClipPan(project, { trackId, itemId, pan }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const value = Number(pan)
  if (!Number.isFinite(value)) throw new EditError('pan must be a number')
  if (value < -1 || value > 1) throw new EditError('pan must stay between -1 and 1')
  if (tidy(value) === tidy(item.pan)) return { project: next, note: '' }
  item.pan = tidy(value)
  return { project: next, note: `调整片段「${item.label || item.id}」声像 ${item.pan}` }
}

/**
 * Fades, clamped so the two can never overlap: a clip whose fades crossed would
 * be quieter than either fade implies, and the renderer multiplies them.
 */
export function setClipFades(project, { trackId, itemId, fadeInSec, fadeOutSec }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const length = itemLength(item)
  const wantIn = fadeInSec === undefined ? item.fadeInSec : Math.max(0, Number(fadeInSec) || 0)
  const wantOut = fadeOutSec === undefined ? item.fadeOutSec : Math.max(0, Number(fadeOutSec) || 0)
  const inValue = tidy(Math.min(wantIn, length))
  const outValue = tidy(Math.min(wantOut, Math.max(0, length - inValue)))
  if (tidy(inValue) === tidy(item.fadeInSec) && tidy(outValue) === tidy(item.fadeOutSec)) {
    return { project: next, note: '' }
  }
  item.fadeInSec = inValue
  item.fadeOutSec = outValue
  return { project: next, note: `调整片段「${item.label || item.id}」淡入淡出` }
}

export function setClipMuted(project, { trackId, itemId, muted }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const value = Boolean(muted)
  if (value === item.muted) return { project: next, note: '' }
  item.muted = value
  return { project: next, note: `${value ? '静音' : '取消静音'}片段「${item.label || item.id}」` }
}

/**
 * Clamp an edit so the project stays inside the hard limits (spec §5.5). Checked
 * before the edit is applied, so the timeline can refuse a drag rather than
 * accept it and fail at save time.
 */
export function assertWithinLimits(project, { maxDurationSec = 900, maxTracks = 20 } = {}) {
  if ((project.tracks ?? []).length > maxTracks) {
    throw new EditError(`a project may hold at most ${maxTracks} tracks`)
  }
  let end = 0
  for (const track of project.tracks ?? []) {
    for (const item of track.items ?? []) end = Math.max(end, itemEnd(item))
  }
  if (Number(project?.video?.durationSec) > end) end = Number(project.video.durationSec)
  if (end > maxDurationSec) {
    throw new EditError(`a project may last at most ${maxDurationSec / 60} minutes, this edit would end at ${end.toFixed(1)}s`)
  }
  return project
}

/** Rename a track. The head shows this, and nothing else depends on it. */
export function renameTrack(project, { trackId, name }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const value = String(name ?? '').trim()
  if (!value) throw new EditError('a track name cannot be empty')
  if (value === track.name) return { project: next, note: '' }
  const before = track.name
  track.name = value.slice(0, 80)
  return { project: next, note: `重命名轨道「${before}」为「${track.name}」` }
}

export function setTrackMuted(project, { trackId, muted }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const value = Boolean(muted)
  if (value === track.muted) return { project: next, note: '' }
  track.muted = value
  // Muting a soloed track used to leave both flags lit. Mute wins in
  // `resolveTrackGain`, so that combination silences the soloed track while solo
  // silences every other one — the whole project goes quiet with two buttons lit
  // and nothing on screen explaining it. Clearing solo makes the two flags mean
  // what their buttons promise: a track is either the one being listened to or
  // the one being switched off.
  const cleared = value && track.solo === true
  if (cleared) track.solo = false
  return {
    project: next,
    note: `${value ? '静音' : '取消静音'}轨道「${track.name}」${cleared ? '（同时取消独奏）' : ''}`,
  }
}

/**
 * Solo is not exclusive: several tracks can be soloed together, and while any is,
 * everything else is silent. Toggling the last one off restores normal playback.
 */
export function setTrackSolo(project, { trackId, solo }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const value = Boolean(solo)
  if (value === track.solo) return { project: next, note: '' }
  track.solo = value
  // Soloing a muted track is the same trap from the other side: `resolveTrackGain`
  // returns 0 for a muted track before it ever looks at solo, so the person would
  // solo something and hear silence while every other track is silenced too.
  // Soloing a track asserts it should be heard, so mute has to give way.
  const cleared = value && track.muted === true
  if (cleared) track.muted = false
  return {
    project: next,
    note: `${value ? '独奏' : '取消独奏'}轨道「${track.name}」${cleared ? '（同时取消静音）' : ''}`,
  }
}

/**
 * Delete a track and everything on it. Its materials stay: they belong to the
 * project index, not to the track (spec §6.5).
 */
export function deleteTrack(project, { trackId }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  next.tracks = next.tracks.filter((entry) => entry.id !== trackId)
  const count = track.items.length
  return {
    project: next,
    note: count > 0
      ? `删除轨道「${track.name}」及其 ${count} 个片段`
      : `删除轨道「${track.name}」`,
  }
}

// --- effect chains (improvement plan 02, I-07) ------------------------------
//
// Three levels, one shape: each of these replaces the whole chain at its level.
// That is deliberate — a chain is an ordered list, and replacing it means the UI
// never has to describe a half-applied edit (insert, move, delete) as three
// separate events in history. The mutators stay pure like everything else here,
// so undo works on them for free.

/** Human name for an effect, for the history line and the panel. */
const FX_LABELS = {
  eq: 'EQ',
  compressor: '压缩',
  limiter: '限幅',
  reverb: '混响',
  delay: '延迟',
  duck: '侧链',
  pitch: '变速变调',
}

function describeFxChain(chain) {
  if (!chain?.length) return '空'
  return chain.map((fx) => FX_LABELS[fx.type] ?? fx.type).join(' → ')
}

function assertChain(chain) {
  if (!Array.isArray(chain)) throw new EditError('an effect chain must be an array')
  for (const fx of chain) {
    if (!fx || typeof fx !== 'object') throw new EditError('each effect must be an object')
    if (!FX_TYPES.includes(fx.type)) throw new EditError(`unknown effect type "${fx.type}"; use ${FX_TYPES.join(', ')}`)
  }
  return chain
}

export function setClipFx(project, { trackId, itemId, chain }) {
  const next = clone(project)
  const track = findTrack(next, trackId)
  const item = findItem(track, itemId)
  const wanted = assertChain(chain)
  if (JSON.stringify(wanted) === JSON.stringify(item.fx ?? [])) return { project: next, note: '' }
  item.fx = wanted.map((fx) => structuredClone(fx))
  return { project: next, note: `设置片段「${item.label || item.id}」效果链（${describeFxChain(item.fx)}）` }
}

/**
 * The bus fader — spec §10.2's "总推子", the one level control that acts on the
 * whole mix.
 *
 * It is not a normalized value: the renderer applies `normalizeGainDb + this`,
 * and the normalization is measured once and frozen, so pulling this down 5 dB
 * lowers the export by exactly 5 dB instead of being compensated away.
 */
export function setMasterFader(project, { masterFaderDb }) {
  const next = clone(project)
  const value = Number(masterFaderDb)
  if (!Number.isFinite(value)) throw new EditError('master fader must be a number')
  if (value < -120 || value > 120) throw new EditError('master fader must stay between -120 and +120 dB')
  if (tidy(value) === tidy(next.masterFaderDb ?? 0)) return { project: next, note: '' }
  next.masterFaderDb = tidy(value)
  return { project: next, note: `调整总线音量 ${next.masterFaderDb} dB` }
}

export function setMasterFx(project, { chain }) {
  const next = clone(project)
  const wanted = assertChain(chain)
  if (JSON.stringify(wanted) === JSON.stringify(next.masterFx ?? [])) return { project: next, note: '' }
  next.masterFx = wanted.map((fx) => structuredClone(fx))
  return { project: next, note: `设置总线效果链（${describeFxChain(next.masterFx)}）` }
}

export { FX_LABELS, describeFxChain }
