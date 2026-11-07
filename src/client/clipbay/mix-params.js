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
  const pan = (Number(item?.pan) || 0) + (Number(track?.pan) || 0)
  return {
    gainDb,
    gain: dbToGain(gainDb),
    pan: Math.max(-1, Math.min(1, pan)),
    fadeInSec: Math.max(0, Number(item?.fadeInSec) || 0),
    fadeOutSec: Math.max(0, Number(item?.fadeOutSec) || 0),
    muted: item?.muted === true || track?.muted === true,
  }
}

/** One track's parameters. Solo is a property, not a gain: see `resolveTrackGain`. */
export function trackParams(track) {
  const volumeDb = Number(track?.volumeDb) || 0
  return {
    volumeDb,
    gain: dbToGain(volumeDb),
    muted: track?.muted === true,
    solo: track?.solo === true,
  }
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
 * The gain of one track, in linear units.
 *
 * Mute wins over solo, and while anything is soloed every other track is silent.
 * Returned as a number rather than a boolean so the same expression drives the
 * scheduled graph, a live fader move and the renderer.
 */
export function resolveTrackGain(track, anySolo) {
  const params = trackParams(track)
  if (params.muted) return 0
  if (anySolo && !params.solo) return 0
  return params.gain
}

/** Tracks that can be heard at all: solo wins over everything, then mute. */
export function audibleTracks(tracks) {
  const list = tracks ?? []
  const soloed = list.filter((track) => track?.solo === true)
  const pool = soloed.length > 0 ? soloed : list
  return pool.filter((track) => track?.muted !== true)
}

/** The fade shape both engines follow: cosine, so it starts and ends flat. */
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
