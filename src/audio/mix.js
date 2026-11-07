import { dbToGain, fadeCurve, panGains } from '../client/clipbay/mix-params.js'
import { fromDb, padOrTrim, peakOf } from './wav.js'

const EPSILON = 1e-9

// The fade shape, the dB conversion and the pan law live in mix-params.js so the
// preview and the renderer cannot drift apart (improvement plan 02, I-04). This
// module applies them to plain arrays; it never restates them.
export { dbToGain, panGains }

export function applyFades(channels, sampleRate, fadeInSec, fadeOutSec) {
  const frames = channels[0].length
  const fadeIn = Math.min(frames, Math.max(0, Math.round(fadeInSec * sampleRate)))
  const fadeOut = Math.min(frames, Math.max(0, Math.round(fadeOutSec * sampleRate)))
  if (!fadeIn && !fadeOut) return channels
  const curve = fadeCurve(frames, sampleRate, fadeInSec, fadeOutSec)
  return channels.map((channel) => {
    const out = Float32Array.from(channel)
    for (let i = 0; i < frames; i++) out[i] *= curve[i]
    return out
  })
}

export function applyGainDb(channels, gainDb) {
  if (!gainDb) return channels
  const gain = dbToGain(gainDb)
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain
    return out
  })
}

/**
 * Add `source` into `acc` at `offsetFrames`, in place. The renderer uses this
 * instead of sumTracks so a 20-track project does not allocate 20 full-length
 * buffers (plan M3).
 */
export function accumulateInto(acc, source, offsetFrames, gainLeft, gainRight) {
  const length = source[0].length
  const start = Math.max(0, offsetFrames)
  const end = Math.min(acc[0].length, offsetFrames + length)
  for (let i = start; i < end; i++) {
    const j = i - offsetFrames
    acc[0][i] += source[0][j] * gainLeft
    acc[1][i] += source[1][j] * gainRight
  }
}

export function sumTracks(parts) {
  if (!parts.length) throw new Error('sumTracks needs at least one track')
  const frames = parts[0][0].length
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (const [l, r] of parts) {
    for (let i = 0; i < frames; i++) {
      left[i] += l[i]
      right[i] += r[i]
    }
  }
  return [left, right]
}

/** Peak-following envelope used to drive ducking (cheap, sample accurate). */
export function buildEnvelope(channels, sampleRate, { attackSec = 0.02, releaseSec = 0.25 } = {}) {
  const frames = channels[0].length
  const env = new Float32Array(frames)
  const attack = Math.exp(-1 / Math.max(1, attackSec * sampleRate))
  const release = Math.exp(-1 / Math.max(1, releaseSec * sampleRate))
  let value = 0
  for (let i = 0; i < frames; i++) {
    const current = Math.max(Math.abs(channels[0][i]), Math.abs(channels[1][i]))
    const coefficient = current > value ? attack : release
    value = coefficient * value + (1 - coefficient) * current
    env[i] = value
  }
  return env
}

/**
 * Compute a ducking gain curve in linear units. The curve follows the
 * narration envelope: full music level below the threshold, up to `targetDb`
 * down while the voice is loud, with slow attack/release so the bed breathes
 * instead of pumping.
 */
export function buildDuckCurve(env, sampleRate, { targetDb = -9, thresholdDb = -42, attackSec = 0.12, releaseSec = 0.4 } = {}) {
  const frames = env.length
  const curve = new Float32Array(frames)
  const targetGain = fromDb(targetDb)
  const attack = Math.exp(-1 / Math.max(1, attackSec * sampleRate))
  const release = Math.exp(-1 / Math.max(1, releaseSec * sampleRate))
  let current = 1
  for (let i = 0; i < frames; i++) {
    const db = 20 * Math.log10(env[i] + EPSILON)
    let wanted = 1
    if (db > thresholdDb) {
      const amount = Math.min(1, (db - thresholdDb) / 20)
      const wantedDb = targetDb * amount
      wanted = fromDb(wantedDb)
    }
    const coefficient = wanted < current ? attack : release
    current = coefficient * current + (1 - coefficient) * wanted
    curve[i] = current
  }
  return curve
}

export function applyCurve(channels, curve) {
  const frames = channels[0].length
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    left[i] = channels[0][i] * curve[i]
    right[i] = channels[1][i] * curve[i]
  }
  return [left, right]
}

export function normalizePeak(channels, targetDb) {
  const peak = peakOf(channels)
  if (peak <= 0) return { channels, gainDb: 0 }
  const gain = Math.pow(10, targetDb / 20) / peak
  const out = channels.map((channel) => {
    const result = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) result[i] = channel[i] * gain
    return result
  })
  return { channels: out, gainDb: 20 * Math.log10(gain) }
}

export function fitFrames(channels, frames) {
  const length = channels[0].length
  if (length === frames) return channels
  return padOrTrim(channels, frames)
}

/** RMS over frames where `mask` is truthy; used for the narration-vs-music report. */
export function maskedRms(channels, mask) {
  let sum = 0
  let count = 0
  const frames = channels[0].length
  for (let i = 0; i < frames; i++) {
    if (!mask[i]) continue
    sum += channels[0][i] * channels[0][i] + channels[1][i] * channels[1][i]
    count += 2
  }
  return count ? Math.sqrt(sum / count) : 0
}

