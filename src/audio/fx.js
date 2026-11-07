/**
 * Effect chains (improvement plan 02, I-07).
 *
 * This file is the *only* implementation of the seven effects. The renderer calls
 * it directly, and the browser preview needs no second copy for the two effects a
 * WebAudio node cannot reproduce (reverb, pitch change with the pitch preserved):
 * those run this same code inside an AudioWorklet, bundled from here.
 *
 * That rule exists because the alternative already burned this project once: two
 * implementations of a gain, a pan and a fade meant the person heard one thing and
 * exported another. Seven more parameters would have been seven more chances.
 *
 * Constraints that shaped it:
 *  - zero Node dependencies (`wav.js` uses Buffer) so the browser can bundle it;
 *  - no allocation inside the sample loop: a 15-minute stereo project is 86M
 *    float samples per pass, and one temporary per frame is a second of GC;
 *  - convolution reverb is out: measured at 81s for a 15-minute project with 2048
 *    taps. Freeverb does the same job in 1.3s.
 */

export const FX_TYPES = ['eq', 'compressor', 'limiter', 'reverb', 'delay', 'duck', 'pitch']

/** A chain longer than this is a mistake, not an arrangement. */
export const MAX_FX_PER_CHAIN = 8

/** Bands in one EQ; six covers everything a voice or a bed needs. */
export const MAX_EQ_BANDS = 6

/** What each effect costs when it is switched on by type alone. */
export function defaultFx(type) {
  switch (type) {
    case 'eq':
      return { type: 'eq', bands: [{ type: 'peaking', freqHz: 1000, gainDb: 0, q: 1 }] }
    case 'compressor':
      return { type: 'compressor', thresholdDb: -18, ratio: 3, attackSec: 0.01, releaseSec: 0.12, kneeDb: 6, makeupDb: 0 }
    case 'limiter':
      return { type: 'limiter', ceilingDb: -1, releaseSec: 0.08 }
    case 'reverb':
      return { type: 'reverb', roomSize: 0.6, damping: 0.4, wet: 0.28, dry: 0.85, width: 0.8 }
    case 'delay':
      return { type: 'delay', timeSec: 0.28, feedback: 0.3, wet: 0.22, dry: 0.85, pingPong: false }
    case 'duck':
      return { type: 'duck', sourceTrackId: '', targetDb: -9, thresholdDb: -42, attackSec: 0.12, releaseSec: 0.4 }
    case 'pitch':
      return { type: 'pitch', rate: 1, pitchSemitones: 0, preservePitch: false }
    default:
      throw new Error(`unknown effect type "${type}"; use ${FX_TYPES.join(', ')}`)
  }
}

function num(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * One effect with every field filled in.
 *
 * Missing parameters are defaults rather than an error: a project written before
 * a field existed keeps working, and the renderer never reads `undefined` into a
 * coefficient. Out-of-range values are clamped here and *rejected* by the schema
 * validator, which is the difference between reading old data and accepting new
 * nonsense.
 */
export function resolveFx(fx) {
  const base = defaultFx(fx?.type)
  switch (base.type) {
    case 'eq': {
      const bands = Array.isArray(fx?.bands) ? fx.bands.slice(0, MAX_EQ_BANDS) : base.bands
      return {
        type: 'eq',
        bands: bands.map((band) => {
          const type = ['peaking', 'lowshelf', 'highshelf'].includes(band?.type) ? band.type : 'peaking'
          return {
            type,
            freqHz: clamp(num(band?.freqHz, 1000), 20, 20000),
            gainDb: clamp(num(band?.gainDb, 0), -24, 24),
            q: clamp(num(band?.q, 1), 0.1, 18),
          }
        }),
      }
    }
    case 'compressor':
      return {
        type: 'compressor',
        thresholdDb: clamp(num(fx?.thresholdDb, base.thresholdDb), -60, 0),
        ratio: clamp(num(fx?.ratio, base.ratio), 1, 20),
        attackSec: clamp(num(fx?.attackSec, base.attackSec), 0.001, 1),
        releaseSec: clamp(num(fx?.releaseSec, base.releaseSec), 0.01, 2),
        kneeDb: clamp(num(fx?.kneeDb, base.kneeDb), 0, 40),
        makeupDb: clamp(num(fx?.makeupDb, base.makeupDb), -24, 24),
      }
    case 'limiter':
      return {
        type: 'limiter',
        ceilingDb: clamp(num(fx?.ceilingDb, base.ceilingDb), -12, 0),
        releaseSec: clamp(num(fx?.releaseSec, base.releaseSec), 0.01, 2),
      }
    case 'reverb':
      return {
        type: 'reverb',
        roomSize: clamp(num(fx?.roomSize, base.roomSize), 0, 1),
        damping: clamp(num(fx?.damping, base.damping), 0, 1),
        wet: clamp(num(fx?.wet, base.wet), 0, 1),
        dry: clamp(num(fx?.dry, base.dry), 0, 1),
        width: clamp(num(fx?.width, base.width), 0, 1),
      }
    case 'delay':
      return {
        type: 'delay',
        timeSec: clamp(num(fx?.timeSec, base.timeSec), 0.01, 2),
        feedback: clamp(num(fx?.feedback, base.feedback), 0, 0.95),
        wet: clamp(num(fx?.wet, base.wet), 0, 1),
        dry: clamp(num(fx?.dry, base.dry), 0, 1),
        pingPong: fx?.pingPong === true,
      }
    case 'duck':
      return {
        type: 'duck',
        sourceTrackId: typeof fx?.sourceTrackId === 'string' ? fx.sourceTrackId.trim() : '',
        targetDb: clamp(num(fx?.targetDb, base.targetDb), -40, 0),
        thresholdDb: clamp(num(fx?.thresholdDb, base.thresholdDb), -60, 0),
        attackSec: clamp(num(fx?.attackSec, base.attackSec), 0.001, 1),
        releaseSec: clamp(num(fx?.releaseSec, base.releaseSec), 0.01, 2),
      }
    case 'pitch':
      return {
        type: 'pitch',
        rate: clamp(num(fx?.rate, 1), 0.25, 4),
        pitchSemitones: clamp(num(fx?.pitchSemitones, 0), -12, 12),
        preservePitch: fx?.preservePitch === true,
      }
    default:
      throw new Error(`unknown effect type "${fx?.type}"`)
  }
}

/** A longer chain than the limit is a mistake; validation rejects it, this trims. */
export function resolveChain(chain) {
  if (!Array.isArray(chain)) return []
  return chain.slice(0, MAX_FX_PER_CHAIN).map((fx) => resolveFx(fx))
}

// ---------------------------------------------------------------------------
// EQ — RBJ biquads, one per band, applied in series
// ---------------------------------------------------------------------------

/**
 * Coefficients for one band, normalised by a0.
 *
 * These are the same formulas `BiquadFilterNode` uses, which is what lets the
 * preview build a native node from the same three numbers and get the same
 * filter instead of an approximation of it.
 */
export function biquadCoefficients(band, sampleRate) {
  const freq = clamp(num(band?.freqHz, 1000), 20, Math.min(20000, sampleRate / 2 - 1))
  const gainDb = clamp(num(band?.gainDb, 0), -24, 24)
  const q = clamp(num(band?.q, 1), 0.1, 18)
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const alpha = sin / (2 * q)
  let b0
  let b1
  let b2
  let a0
  let a1
  let a2
  switch (band?.type) {
    case 'lowshelf': {
      const sqrtA = Math.sqrt(A)
      const twoSqrtAAlpha = 2 * sqrtA * alpha
      b0 = A * ((A + 1) - (A - 1) * cos + twoSqrtAAlpha)
      b1 = 2 * A * ((A - 1) - (A + 1) * cos)
      b2 = A * ((A + 1) - (A - 1) * cos - twoSqrtAAlpha)
      a0 = (A + 1) + (A - 1) * cos + twoSqrtAAlpha
      a1 = -2 * ((A - 1) + (A + 1) * cos)
      a2 = (A + 1) + (A - 1) * cos - twoSqrtAAlpha
      break
    }
    case 'highshelf': {
      const sqrtA = Math.sqrt(A)
      const twoSqrtAAlpha = 2 * sqrtA * alpha
      b0 = A * ((A + 1) + (A - 1) * cos + twoSqrtAAlpha)
      b1 = -2 * A * ((A - 1) + (A + 1) * cos)
      b2 = A * ((A + 1) + (A - 1) * cos - twoSqrtAAlpha)
      a0 = (A + 1) - (A - 1) * cos + twoSqrtAAlpha
      a1 = 2 * ((A - 1) - (A + 1) * cos)
      a2 = (A + 1) - (A - 1) * cos - twoSqrtAAlpha
      break
    }
    default: {
      b0 = 1 + alpha * A
      b1 = -2 * cos
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cos
      a2 = 1 - alpha / A
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

function applyBiquad(channels, coefficients) {
  const { b0, b1, b2, a1, a2 } = coefficients
  for (let channel = 0; channel < channels.length; channel++) {
    const data = channels[channel]
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i]
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = y0
      data[i] = y0
    }
  }
  return channels
}

export function applyEq(channels, sampleRate, fx) {
  const resolved = resolveFx(fx)
  let out = channels
  for (const band of resolved.bands) {
    if (!band.gainDb) continue
    out = applyBiquad(out, biquadCoefficients(band, sampleRate))
  }
  return out
}

// ---------------------------------------------------------------------------
// Compressor and limiter
// ---------------------------------------------------------------------------

/** Peak detector shared by both dynamics effects: linked, so the image holds. */
function peakEnvelope(channels, attackSec, releaseSec, sampleRate) {
  const frames = channels[0].length
  const env = new Float32Array(frames)
  const attack = Math.exp(-1 / Math.max(1, attackSec * sampleRate))
  const release = Math.exp(-1 / Math.max(1, releaseSec * sampleRate))
  let value = 0
  for (let i = 0; i < frames; i++) {
    const current = Math.max(Math.abs(channels[0][i]), Math.abs(channels[1]?.[i] ?? channels[0][i]))
    const coefficient = current > value ? attack : release
    value = coefficient * value + (1 - coefficient) * current
    env[i] = value
  }
  return env
}

/** Static soft-knee curve: input level in dB → output level in dB. */
export function compressorCurve(levelDb, { thresholdDb, ratio, kneeDb }) {
  const knee = Math.max(0, kneeDb)
  if (knee > 0 && levelDb > thresholdDb - knee / 2 && levelDb < thresholdDb + knee / 2) {
    const delta = levelDb - thresholdDb + knee / 2
    return levelDb + ((1 / ratio - 1) * delta * delta) / (2 * knee)
  }
  if (levelDb <= thresholdDb - knee / 2) return levelDb
  return thresholdDb + (levelDb - thresholdDb) / ratio
}

export function applyCompressor(channels, sampleRate, fx) {
  const resolved = resolveFx(fx)
  const env = peakEnvelope(channels, resolved.attackSec, resolved.releaseSec, sampleRate)
  const makeup = 10 ** (resolved.makeupDb / 20)
  for (let channel = 0; channel < channels.length; channel++) {
    const data = channels[channel]
    for (let i = 0; i < data.length; i++) {
      const levelDb = 20 * Math.log10(env[i] + 1e-9)
      const outDb = compressorCurve(levelDb, resolved)
      data[i] *= 10 ** ((outDb - levelDb) / 20) * makeup
    }
  }
  return channels
}

export function applyLimiter(channels, sampleRate, fx) {
  const resolved = resolveFx(fx)
  const ceiling = 10 ** (resolved.ceilingDb / 20)
  const release = Math.exp(-1 / Math.max(1, resolved.releaseSec * sampleRate))
  // A single gain factor shared by both channels: independent per-channel
  // limiting would pull the stereo image together on every loud peak.
  let gain = 1
  const frames = channels[0].length
  for (let i = 0; i < frames; i++) {
    const peak = Math.max(Math.abs(channels[0][i]), Math.abs(channels[1]?.[i] ?? channels[0][i]))
    // Instant attack, smooth recovery: the ceiling is a promise, the release is
    // taste.
    const wanted = peak > ceiling ? ceiling / peak : 1
    gain = wanted < gain ? wanted : release * gain + (1 - release) * wanted
    if (gain > 1) gain = 1
    channels[0][i] *= gain
    if (channels[1]) channels[1][i] *= gain
  }
  return channels
}

// ---------------------------------------------------------------------------
// Reverb — Freeverb: 8 combs and 4 allpasses per channel
// ---------------------------------------------------------------------------

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_TUNING = [556, 441, 341, 225]
const STEREO_SPREAD = 23
const FIXED_GAIN = 0.015

/**
 * A Freeverb processor, block by block.
 *
 * This is a factory rather than one whole-buffer function so the browser can run
 * the very same code inside an AudioWorklet: a worklet is handed 128-frame blocks
 * and has to keep its state between them, while the renderer hands over a whole
 * clip. Both call this, so the tail a person hears in the preview is the tail the
 * export contains — not a `ConvolverNode` approximating it.
 */
export function createReverbProcessor(sampleRate, fx) {
  const resolved = resolveFx(fx)
  const scale = sampleRate / 44100
  const feedback = resolved.roomSize * 0.28 + 0.7
  const damp1 = resolved.damping * 0.4
  const damp2 = 1 - damp1
  const wet1 = resolved.wet * (resolved.width / 2 + 0.5)
  const wet2 = resolved.wet * ((1 - resolved.width) / 2)
  const dry = resolved.dry

  const makeBank = (offset) => ({
    combs: COMB_TUNING.map((tuning) => ({
      buffer: new Float32Array(Math.max(1, Math.round((tuning + offset) * scale))),
      index: 0,
      store: 0,
    })),
    allpasses: ALLPASS_TUNING.map((tuning) => ({
      buffer: new Float32Array(Math.max(1, Math.round((tuning + offset) * scale))),
      index: 0,
    })),
  })
  const left = makeBank(0)
  const right = makeBank(STEREO_SPREAD)

  const runBank = (bank, inputLeft, inputRight, output, count) => {
    for (let i = 0; i < count; i++) {
      const input = (inputLeft[i] + inputRight[i]) * FIXED_GAIN
      let sample = 0
      for (const comb of bank.combs) {
        const buffer = comb.buffer
        const index = comb.index
        const stored = buffer[index]
        comb.store = stored * damp2 + comb.store * damp1
        buffer[index] = input + comb.store * feedback
        comb.index = index + 1 >= buffer.length ? 0 : index + 1
        sample += stored
      }
      for (const allpass of bank.allpasses) {
        const buffer = allpass.buffer
        const index = allpass.index
        const stored = buffer[index]
        buffer[index] = sample + stored * 0.5
        allpass.index = index + 1 >= buffer.length ? 0 : index + 1
        sample = stored - sample
      }
      output[i] = sample
    }
  }

  let wetLeft = new Float32Array(128)
  let wetRight = new Float32Array(128)
  return {
    /**
     * Process one block in place. Blocks may be any length; state carries over, so
     * a 128-frame worklet block and one 15-minute buffer give the same result.
     */
    process(channels, frames = channels[0].length) {
      if (wetLeft.length < frames) {
        wetLeft = new Float32Array(frames)
        wetRight = new Float32Array(frames)
      }
      const inputLeft = channels[0]
      const inputRight = channels[1] ?? channels[0]
      runBank(left, inputLeft, inputRight, wetLeft, frames)
      runBank(right, inputLeft, inputRight, wetRight, frames)
      for (let i = 0; i < frames; i++) {
        const dryLeft = inputLeft[i] * dry
        const dryRight = inputRight[i] * dry
        channels[0][i] = dryLeft + wetLeft[i] * wet1 + wetRight[i] * wet2
        if (channels[1]) channels[1][i] = dryRight + wetRight[i] * wet1 + wetLeft[i] * wet2
      }
      return channels
    },
  }
}

export function applyReverb(channels, sampleRate, fx) {
  return createReverbProcessor(sampleRate, fx).process(channels)
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

export function applyDelay(channels, sampleRate, fx) {
  const resolved = resolveFx(fx)
  const delayFrames = Math.max(1, Math.round(resolved.timeSec * sampleRate))
  const frames = channels[0].length
  const leftLine = new Float32Array(frames + delayFrames)
  const rightLine = new Float32Array(frames + delayFrames)
  const dryLeft = Float32Array.from(channels[0])
  const dryRight = Float32Array.from(channels[1] ?? channels[0])
  for (let i = 0; i < frames; i++) {
    const readLeft = leftLine[i]
    const readRight = rightLine[i]
    const inLeft = dryLeft[i]
    const inRight = dryRight[i]
    // Ping-pong crosses the feedback paths, so the echo walks across the image.
    leftLine[i + delayFrames] = resolved.pingPong
      ? inLeft + readRight * resolved.feedback
      : inLeft + readLeft * resolved.feedback
    rightLine[i + delayFrames] = resolved.pingPong
      ? inRight + readLeft * resolved.feedback
      : inRight + readRight * resolved.feedback
    channels[0][i] = inLeft * resolved.dry + readLeft * resolved.wet
    if (channels[1]) channels[1][i] = inRight * resolved.dry + readRight * resolved.wet
  }
  return channels
}

// ---------------------------------------------------------------------------
// Ducking (sidechain)
// ---------------------------------------------------------------------------

/**
 * The ducking curve, as the preview and the renderer both need it.
 *
 * `envelope` is the sidechain track's peak envelope, sampled at `sampleRate`.
 * A mono signal is what drives it: what matters is when the voice is present,
 * not which side of the stereo field it came from.
 */
export function buildDuckCurve(envelope, sampleRate, { targetDb = -9, thresholdDb = -42, attackSec = 0.12, releaseSec = 0.4 } = {}) {
  const frames = envelope.length
  const curve = new Float32Array(frames)
  const targetGain = 10 ** (targetDb / 20)
  const attack = Math.exp(-1 / Math.max(1, attackSec * sampleRate))
  const release = Math.exp(-1 / Math.max(1, releaseSec * sampleRate))
  let current = 1
  for (let i = 0; i < frames; i++) {
    const db = 20 * Math.log10(envelope[i] + 1e-9)
    let wanted = 1
    if (db > thresholdDb) {
      const amount = Math.min(1, (db - thresholdDb) / 20)
      wanted = targetGain ** amount
    }
    const coefficient = wanted < current ? attack : release
    current = coefficient * current + (1 - coefficient) * wanted
    curve[i] = current
  }
  return curve
}

/** Peak envelope of a stereo buffer, mono-summed — the sidechain detector input. */
export function monoEnvelope(channels) {
  const frames = channels[0].length
  const env = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    env[i] = Math.max(Math.abs(channels[0][i]), Math.abs(channels[1]?.[i] ?? channels[0][i]))
  }
  return env
}

export function applyDuck(channels, sampleRate, fx, envelope) {
  const resolved = resolveFx(fx)
  if (!envelope || envelope.length === 0) return channels
  const curve = buildDuckCurve(envelope, sampleRate, resolved)
  const frames = Math.min(channels[0].length, curve.length)
  for (let i = 0; i < frames; i++) {
    channels[0][i] *= curve[i]
    if (channels[1]) channels[1][i] *= curve[i]
  }
  return channels
}

// ---------------------------------------------------------------------------
// Pitch and speed
// ---------------------------------------------------------------------------

/**
 * How much faster the material is consumed: 1 is untouched.
 *
 * `pitchSemitones` is a varispeed factor (a semitone is 2^(1/12) of speed), which
 * is what a tape machine does and what `playbackRate` does in the browser. With
 * `preservePitch` the caller gets the same length but the pitch kept — see
 * `applyPitch`, which stretches instead of resampling.
 */
export function pitchFactor(fx) {
  const resolved = resolveFx(fx)
  return clamp(resolved.rate * 2 ** (resolved.pitchSemitones / 12), 0.0625, 16)
}

/** Linear interpolation is enough for a small musical shift on programme audio. */
function resampleChannels(channels, factor) {
  const frames = channels[0].length
  const outFrames = Math.max(1, Math.round(frames / factor))
  return channels.map((source) => {
    const out = new Float32Array(outFrames)
    for (let i = 0; i < outFrames; i++) {
      const position = i * factor
      const index = Math.floor(position)
      const frac = position - index
      const a = source[Math.min(index, source.length - 1)] ?? 0
      const b = source[Math.min(index + 1, source.length - 1)] ?? a
      out[i] = a + (b - a) * frac
    }
    return out
  })
}

/**
 * Granular overlap-add: change the length, keep the pitch.
 *
 * Grains of 60 ms with a Hann window and a 50% overlap are enough for speech and
 * pads; it is not a phase vocoder and does not claim to be. Both the preview and
 * the renderer call this, so a clip sounds the same either way.
 */
function stretchChannels(channels, factor) {
  const frames = channels[0].length
  const outFrames = Math.max(1, Math.round(frames / factor))
  const grain = Math.max(64, Math.round(0.06 * 44100))
  const hopOut = Math.floor(grain / 2)
  const window = new Float32Array(grain)
  for (let i = 0; i < grain; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grain)
  return channels.map((source) => {
    const out = new Float32Array(outFrames)
    const weight = new Float32Array(outFrames)
    for (let start = 0; start < outFrames; start += hopOut) {
      const sourceStart = Math.round(start * factor)
      for (let i = 0; i < grain; i++) {
        const target = start + i
        if (target >= outFrames) break
        const from = sourceStart + i
        if (from >= source.length) break
        out[target] += source[from] * window[i]
        weight[target] += window[i]
      }
    }
    for (let i = 0; i < outFrames; i++) if (weight[i] > 1e-6) out[i] /= weight[i]
    return out
  })
}

/**
 * Apply a speed/pitch change.
 *
 * `preservePitch` keeps the pitch and changes how much material the clip covers;
 * otherwise both move together, the way varispeed does. The result is returned at
 * the material's own length when `preserveLength` is asked for (the renderer's
 * default for a clip inside a fixed-length slot): a clip's place on the timeline
 * is decided by the project, not by the effect.
 */
export function applyPitch(channels, sampleRate, fx, { preserveLength = false } = {}) {
  const resolved = resolveFx(fx)
  const factor = pitchFactor(resolved)
  if (Math.abs(factor - 1) < 1e-9) return channels
  let out = resolved.preservePitch ? stretchChannels(channels, factor) : resampleChannels(channels, factor)
  if (preserveLength) {
    const target = channels[0].length
    out = out.map((source) => {
      if (source.length === target) return source
      const fitted = new Float32Array(target)
      fitted.set(source.subarray(0, Math.min(source.length, target)))
      return fitted
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * Run a chain over one stereo buffer, in order.
 *
 * A chain without a `duck` entry needs nothing else. `duck` reads a sidechain
 * envelope from `context.duckEnvelopes` (a Map from track id to envelope), which
 * the renderer fills by rendering the source track first: the detector wants the
 * source track's signal, not its effects.
 */
export function applyFxChain(channels, sampleRate, chain, context = {}) {
  const resolved = resolveChain(chain)
  if (resolved.length === 0) return channels
  let out = channels
  for (const fx of resolved) {
    switch (fx.type) {
      case 'eq': out = applyEq(out, sampleRate, fx); break
      case 'compressor': out = applyCompressor(out, sampleRate, fx); break
      case 'limiter': out = applyLimiter(out, sampleRate, fx); break
      case 'reverb': out = applyReverb(out, sampleRate, fx); break
      case 'delay': out = applyDelay(out, sampleRate, fx); break
      case 'duck': out = applyDuck(out, sampleRate, fx, context.duckEnvelopes?.get(fx.sourceTrackId)); break
      case 'pitch': out = applyPitch(out, sampleRate, fx, { preserveLength: context.preserveLength === true }); break
      default: break
    }
  }
  return out
}

/** True when a chain contains something the preview cannot build from native nodes. */
export function needsWorklet(chain) {
  return resolveChain(chain).some((fx) => fx.type === 'reverb')
}
