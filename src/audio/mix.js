import { dbToGain, fadeCurve, panGains } from '../client/clipbay/mix-params.js'

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
 * instead of summing whole tracks so a 20-track project does not allocate 20
 * full-length buffers (plan M3).
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
