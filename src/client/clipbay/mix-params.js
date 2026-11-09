/**
 * The only place a mix parameter becomes a number (improvement plan 02, I-04).
 *
 * Preview and export are two different engines — WebAudio nodes in the browser,
 * plain array maths on the host — so they can never share the code that applies
 * a parameter. What they must share is the *value*: which fields add up, which
 * one wins over which, and what curve a fade follows. That is what lives here.
 *
 * Both `src/client/clipbay/audio.js` and `src/project/render.js` import this
 * module, and neither may compute a gain, a pan or a fade on its own. The rule
 * exists because the first version of the clip bay had two copies: the preview
 * multiplied `master.gain = 1` while the renderer used
 * `normalizeGainDb + masterFaderDb`, and a fade was linear in one and cosine in
 * the other — so the person heard one thing and exported another.
 *
 * Zero Node dependencies on purpose: this file is bundled into the browser, so
 * it must not reach for `Buffer` (which `src/audio/wav.js` uses).
 */

/** dB → linear gain. 0 dB is exactly 1, so unity really is a pass-through. */
export function dbToGain(db) {
  const value = Number(db) || 0
  return value === 0 ? 1 : 10 ** (value / 20)
}

/**
 * Equal-power gains for a pan value.
 *
 * Centre is a true bypass (1, 1) rather than the 0.707 the raw formula gives, so
 * a centred clip is never 3 dB quieter than the same clip with panning removed.
 */
export function panGains(pan) {
  const amount = Math.max(-1, Math.min(1, Number(pan) || 0))
  if (amount === 0) return [1, 1]
  const angle = ((amount + 1) * Math.PI) / 4
  return [Math.cos(angle), Math.sin(angle)]
}

/**
 * One clip's parameters, as both engines read them.
 *
 * Clip pan and track pan add up and are then clamped once; mute is either side's
 * mute. The fade lengths stay in seconds and are converted per engine, because
 * one works in frames and the other in AudioContext time.
 */
export function itemParams(item, track) {
  const gainDb = Number(item?.gainDb) || 0
  return {
    gainDb,
    gain: dbToGain(gainDb),
    // The clip's pan, and nothing else. A track used to add its own pan on top,
    // which made the same field mean two things and put a second copy of every
    // balance decision one level up (improvement plan 03, I-41).
    pan: Math.max(-1, Math.min(1, Number(item?.pan) || 0)),
    fadeInSec: Math.max(0, Number(item?.fadeInSec) || 0),
    fadeOutSec: Math.max(0, Number(item?.fadeOutSec) || 0),
    muted: item?.muted === true || track?.muted === true,
  }
}

/**
 * Where the last clip on the timeline ends, in seconds.
 *
 * Deliberately narrower than `contentEndSec` in serialize.js: that one also
 * counts the picture's length, and the transport needs this number for one
 * question only — "is there anything left to play from here". A 60 s video whose
 * audio ends at 59 s has one silent second; a play press in it is not content.
 */
export function contentEnd(project) {
  let end = 0
  for (const track of project?.tracks ?? []) {
    for (const item of track?.items ?? []) {
      const length = Number(item?.outSec) - Number(item?.inSec)
      if (!(length > 0)) continue
      end = Math.max(end, (Number(item?.startSec) || 0) + length)
    }
  }
  return end
}

/**
 * Where a press of play actually starts.
 *
 * Pressing play once a playback has run to its end used to schedule nothing —
 * `scheduleClips` drops every clip that ended before the playhead — so the
 * button snapped back to ▶ and not one thing moved, with no explanation. The
 * playhead is left at the end by definition, so that was every second press.
 * Asking for a replay from the start is what every player does; it is also the
 * only reading of "play" that has something to play.
 */
export function playbackStart(project, askedSec) {
  const asked = Math.max(0, Number(askedSec) || 0)
  const end = contentEnd(project)
  if (end > 0 && asked >= end) return 0
  return asked
}

/**
 * The master gain: the frozen normalisation plus the person's fader, applied
 * once and never measured back (spec §10.2).
 */
export function masterParams(project) {
  const normalizeGainDb = Number(project?.normalizeGainDb) || 0
  const masterFaderDb = Number(project?.masterFaderDb) || 0
  const gainDb = normalizeGainDb + masterFaderDb
  return { normalizeGainDb, masterFaderDb, gainDb, gain: dbToGain(gainDb) }
}

/**
 * The gain of one track, in linear units: 1 or 0.
 *
 * A track has no fader any more (improvement plan 03, I-41). Everything a fader
 * used to do is done per clip, and the reasoning is the same for every effect
 * parameter: an Agent that can change a hundred clips' gain in one call can hang
 * a reverb on a hundred clips in one call, so a second copy of the decision at
 * track level only creates two places to disagree.
 *
 * What is left is what a track still is — a grouping — and its one audible
 * property: mute and solo. Returned as a number rather than a boolean so the same
 * expression drives the scheduled graph, a live change and the renderer.
 */
export function resolveTrackGain(track, anySolo) {
  if (track?.muted === true) return 0
  if (anySolo && track?.solo !== true) return 0
  return 1
}

/** Tracks that can be heard at all: solo wins over everything, then mute. */
export function audibleTracks(tracks) {
  const list = tracks ?? []
  const soloed = list.filter((track) => track?.solo === true)
  const pool = soloed.length > 0 ? soloed : list
  return pool.filter((track) => track?.muted !== true)
}

/**
 * Bring any channel count to the two the clip bay mixes in.
 *
 * This is the third rule that has to be shared, next to the gain, the pan and
 * the fade. It was not, and the result was the same class of defect the rest of
 * this module exists to prevent: TTS writes mono WAVs, the renderer duplicated
 * the channel and exported a centred mix, while the preview handed the mono
 * buffer straight to a `ChannelSplitter(2)` — and WebAudio fills only output 0
 * from a mono input, so every narration line came out of the left speaker only
 * (measured: left −6 dB, right −180 dB). The person heard a broken preview and
 * an export that did not match it.
 *
 * Mono duplicates to both sides rather than being panned or halved, which is
 * what `conformChannels` has always done on the import path. More than two
 * channels average down, so a 5.1 file cannot silently lose its centre.
 */
export function toStereoChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return null
  const [first] = channels
  if (channels.length === 1) return [first, first]
  if (channels.length === 2) return [channels[0], channels[1]]
  const frames = first.length
  const mono = new Float32Array(frames)
  for (const channel of channels) {
    for (let index = 0; index < frames; index++) mono[index] += channel[index] / channels.length
  }
  return [mono, mono]
}

/**
 * The fade shape both engines follow: cosine, so it starts and ends flat.
 */
export function fadeShape(progress) {
  const value = Math.max(0, Math.min(1, Number(progress) || 0))
  return 0.5 - 0.5 * Math.cos(Math.PI * value)
}

/**
 * Per-frame fade gain for one clip.
 *
 * `sampleRate` is frames per second of whatever is being sampled — the renderer
 * passes the project rate and gets one gain per audio frame; the preview passes
 * a coarser value and gets a short curve for `setValueCurveAtTime`, which
 * interpolates between the points it is given. Both are the same curve.
 */
export function fadeCurve(frames, sampleRate, fadeInSec, fadeOutSec) {
  const total = Math.max(0, Math.floor(Number(frames) || 0))
  const curve = new Float32Array(total)
  const rate = Number(sampleRate) || 0
  const fadeIn = Math.min(total, Math.max(0, Math.round((Number(fadeInSec) || 0) * rate)))
  const fadeOut = Math.min(total, Math.max(0, Math.round((Number(fadeOutSec) || 0) * rate)))
  for (let index = 0; index < total; index++) {
    let gain = 1
    if (fadeIn > 0 && index < fadeIn) gain *= fadeShape(index / fadeIn)
    const tail = total - 1 - index
    if (fadeOut > 0 && tail < fadeOut) gain *= fadeShape(tail / fadeOut)
    curve[index] = gain
  }
  return curve
}
