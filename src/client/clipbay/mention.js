/**
 * The text the 添加到对话 button writes into the chat draft (spec §9.3).
 *
 * It is plain Markdown with a custom URI, not a reference chip: the user can edit
 * or delete it like any other text, and the host's `agent/pre-step` hook turns it
 * into structured context when the message is sent (src/host/timeline-ref.js).
 *
 * Shape:
 *   @[鼓组 00:01:12–00:01:26](anyaudio://timeline/prj_ab12cd34/trk_01@72.0-86.0)
 *
 * The project id is in the URI because a track id is only unique inside one
 * project — spec §9.3's shorter form would be ambiguous in a workspace with more
 * than one project.
 */
import { itemLengthSec } from './serialize.js'

/** `72.5` → `1:12.5`; the label the person reads. */
export function formatClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const whole = Math.floor(value)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const tenths = Math.round((value - whole) * 10)
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  const base = hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`
  return tenths === 0 ? base : `${base}.${tenths}`
}

/** Seconds in the URI: always one decimal, so the host can parse it back exactly. */
function uriSeconds(value) {
  return (Math.max(0, Number(value) || 0)).toFixed(1)
}

/**
 * Build the mention for one selection. A clip names itself; a track names itself
 * plus the range when one is selected.
 *
 * Returns null when there is nothing to point at, so the button can be disabled
 * instead of writing a mention the host cannot resolve.
 */
export function buildMention(project, { trackId, itemId, fromSec, toSec } = {}) {
  if (!project?.id) return null
  const track = project.tracks.find((entry) => entry.id === trackId)
  if (!track) return null

  if (itemId) {
    const item = track.items.find((entry) => entry.id === itemId)
    if (!item) return null
    const label = item.label || track.name
    return {
      text: `@[${label}](anyaudio://timeline/${project.id}/${item.id})`,
      label,
      trackName: track.name,
      target: item.id,
      fromSec: null,
      toSec: null,
    }
  }

  const hasRange = Number.isFinite(fromSec) && Number.isFinite(toSec) && toSec > fromSec
  if (!hasRange) {
    return {
      text: `@[${track.name}](anyaudio://timeline/${project.id}/${track.id})`,
      label: track.name,
      trackName: track.name,
      target: track.id,
      fromSec: null,
      toSec: null,
    }
  }

  const label = `${track.name} ${formatClock(fromSec)}–${formatClock(toSec)}`
  return {
    text: `@[${label}](anyaudio://timeline/${project.id}/${track.id}@${uriSeconds(fromSec)}-${uriSeconds(toSec)})`,
    label,
    trackName: track.name,
    target: track.id,
    fromSec,
    toSec,
  }
}

/** Clamp a dragged range to the content so a stray pointer cannot cite thin air. */
export function clampRange(fromSec, toSec, durationSec) {
  const limit = Math.max(0, Number(durationSec) || 0)
  const a = Math.min(Math.max(0, Number(fromSec) || 0), limit)
  const b = Math.min(Math.max(0, Number(toSec) || 0), limit)
  return a <= b ? { fromSec: a, toSec: b } : { fromSec: b, toSec: a }
}

/** Where a clip sits on the timeline, for the label. */
export function clipSpan(item) {
  const start = Number(item?.startSec) || 0
  return { startSec: start, endSec: start + itemLengthSec(item) }
}

/**
 * Append a mention to whatever the person already typed.
 *
 * `setDraft` replaces the whole draft, so the append has to be computed from the
 * current text first — otherwise one click would wipe a half-written sentence
 * (plan M6: "不得覆盖用户已输的内容"). A mention goes on its own line so the
 * instruction that follows reads as a separate sentence.
 */
export function appendToDraft(currentDraft, mentionText) {
  const existing = typeof currentDraft === 'string' ? currentDraft : ''
  if (!mentionText) return existing
  if (existing.trim() === '') return mentionText
  return `${existing.replace(/\s+$/, '')}\n${mentionText}`
}
