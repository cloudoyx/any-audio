import { peakOf } from './wav.js'

const TWO_PI = Math.PI * 2

/** Deterministic per-item noise so repeat renders are identical. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function noise(rand, frames) {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = rand() * 2 - 1
  return out
}

function lowpass(signal, cutoffHz, sampleRate, passes = 1) {
  const coefficient = 1 - Math.exp((-TWO_PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate)
  const out = Float32Array.from(signal)
  for (let pass = 0; pass < passes; pass++) {
    let state = 0
    for (let i = 0; i < out.length; i++) {
      state += coefficient * (out[i] - state)
      out[i] = state
    }
  }
  return out
}

function highpass(signal, cutoffHz, sampleRate, passes = 1) {
  const coefficient = 1 - Math.exp((-TWO_PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate)
  const out = Float32Array.from(signal)
  for (let pass = 0; pass < passes; pass++) {
    let state = 0
    for (let i = 0; i < out.length; i++) {
      state += coefficient * (out[i] - state)
      out[i] = out[i] - state
    }
  }
  return out
}

/** Chamberlin state-variable filter, used for resonant sweeps (whoosh, water). */
function svfBandpass(signal, cutoffAt, q, sampleRate) {
  const out = new Float32Array(signal.length)
  let low = 0
  let band = 0
  const damping = 1 / Math.max(0.5, q)
  for (let i = 0; i < signal.length; i++) {
    const cutoff = Math.min(cutoffAt(i / signal.length), sampleRate * 0.16)
    const f = 2 * Math.sin((Math.PI * cutoff) / sampleRate)
    const high = signal[i] - low - damping * band
    band += f * high
    low += f * band
    out[i] = band
  }
  return out
}

function envelope(frames, { attackSec = 0.01, decaySec = 1, curve = 3, sampleRate }) {
  const out = new Float32Array(frames)
  const attack = Math.max(1, attackSec * sampleRate)
  for (let i = 0; i < frames; i++) {
    const rise = Math.min(1, i / attack)
    const t = (i - attack) / sampleRate
    const fall = t <= 0 ? 1 : Math.exp(-curve * (t / Math.max(0.001, decaySec)))
    out[i] = rise * fall
  }
  return out
}

function normalize(signal, target = 0.9) {
  const peak = peakOf([signal])
  if (peak <= 0) return signal
  const gain = target / peak
  for (let i = 0; i < signal.length; i++) signal[i] *= gain
  return signal
}

function gustCurve(frames, sampleRate, rand, rate = 0.25, depth = 0.6) {
  const points = Math.max(2, Math.ceil((frames / sampleRate) * rate * 4))
  const control = Array.from({ length: points }, () => rand())
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const x = (i / frames) * (points - 1)
    const index = Math.floor(x)
    const frac = x - index
    const a = control[index] ?? 0.5
    const b = control[index + 1] ?? a
    out[i] = 1 - depth + depth * (a + (b - a) * (frac * frac * (3 - 2 * frac)))
  }
  return out
}

function sweep(frames, from, to, exponent = 2) {
  return (ratio) => from * Math.pow(to / from, Math.pow(ratio, 1 / exponent))
}

const GENERATORS = {
  wind({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const brightness = clamp01(params.brightness ?? 0.45)
    const intensity = clamp01(params.intensity ?? 0.6)
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const gustL = gustCurve(frames, sampleRate, rand, params.gustRate ?? 0.2, 0.65)
    const gustR = gustCurve(frames, sampleRate, mulberry32(rand() * 1e9), params.gustRate ?? 0.2, 0.65)
    const noiseL = lowpass(highpass(noise(rand, frames), 60, sampleRate), 300 + 2600 * brightness, sampleRate, 2)
    const noiseR = lowpass(highpass(noise(mulberry32(rand() * 1e9), frames), 60, sampleRate), 300 + 2600 * brightness, sampleRate, 2)
    for (let i = 0; i < frames; i++) {
      left[i] = noiseL[i] * gustL[i] * intensity
      right[i] = noiseR[i] * gustR[i] * intensity
    }
    return [left, right]
  },

  rain({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const intensity = clamp01(params.intensity ?? 0.6)
    const left = lowpass(highpass(noise(rand, frames), 1200, sampleRate, 2), 7000, sampleRate)
    const right = lowpass(highpass(noise(mulberry32(rand() * 1e9), frames), 1200, sampleRate, 2), 7000, sampleRate)
    const drops = Math.round(durationSec * 18)
    for (let d = 0; d < drops; d++) {
      const at = Math.floor(rand() * frames)
      const length = Math.floor((0.002 + rand() * 0.01) * sampleRate)
      const channel = rand() < 0.5 ? left : right
      for (let i = 0; i < length; i++) channel[Math.min(frames - 1, at + i)] += (rand() * 2 - 1) * Math.exp(-i / (length / 3)) * 0.6
    }
    for (let i = 0; i < frames; i++) {
      left[i] *= intensity
      right[i] *= intensity
    }
    return [left, right]
  },

  water({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const intensity = clamp01(params.intensity ?? 0.6)
    const base = params.rate ? 300 + 900 * params.rate : 700
    const wobble = (ratio) => base * (1 + 0.35 * Math.sin(ratio * TWO_PI * 3))
    const left = svfBandpass(noise(rand, frames), wobble, 4, sampleRate)
    const right = svfBandpass(noise(mulberry32(rand() * 1e9), frames), (ratio) => wobble(ratio) * 1.08, 4, sampleRate)
    const bubbles = Math.round(durationSec * 9)
    for (let b = 0; b < bubbles; b++) {
      const at = Math.floor(rand() * frames)
      const length = Math.floor((0.03 + rand() * 0.05) * sampleRate)
      const channel = rand() < 0.5 ? left : right
      for (let i = 0; i < length; i++) channel[Math.min(frames - 1, at + i)] += Math.sin((TWO_PI * (420 + rand() * 200) * i) / sampleRate) * Math.exp(-i / (length / 4)) * 0.25
    }
    for (let i = 0; i < frames; i++) {
      left[i] *= intensity
      right[i] *= intensity
    }
    return [left, right]
  },

  fire({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const intensity = clamp01(params.intensity ?? 0.6)
    const roar = lowpass(noise(rand, frames), 600, sampleRate, 2)
    const hiss = lowpass(highpass(noise(mulberry32(rand() * 1e9), frames), 1500, sampleRate), 6000, sampleRate)
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const bed = roar[i] * 0.5 + hiss[i] * 0.3
      left[i] = bed
      right[i] = bed * 0.9
    }
    const crackles = Math.round(durationSec * 26)
    for (let c = 0; c < crackles; c++) {
      const at = Math.floor(rand() * frames)
      const length = Math.floor((0.001 + rand() * 0.02) * sampleRate)
      const channel = rand() < 0.5 ? left : right
      for (let i = 0; i < length; i++) channel[Math.min(frames - 1, at + i)] += (rand() * 2 - 1) * Math.exp(-i / (length / 3)) * (0.4 + rand() * 0.6)
    }
    for (let i = 0; i < frames; i++) {
      left[i] *= intensity
      right[i] *= intensity
    }
    return [left, right]
  },

  birds({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const intensity = clamp01(params.intensity ?? 0.5)
    const rate = params.rate ?? 1.2
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const calls = Math.max(1, Math.round(durationSec * rate))
    for (let c = 0; c < calls; c++) {
      const channel = rand() < 0.45 ? right : left
      const start = Math.floor(rand() * frames)
      const notes = 2 + Math.floor(rand() * 4)
      let cursor = start
      const base = 2200 + rand() * 1400
      for (let n = 0; n < notes; n++) {
        const length = Math.floor((0.05 + rand() * 0.09) * sampleRate)
        const from = base * (1 + (rand() - 0.5) * 0.4)
        const to = from * (1 + (rand() - 0.5) * 0.6)
        for (let i = 0; i < length; i++) {
          const ratio = i / length
          const freq = from + (to - from) * ratio + Math.sin((ratio * TWO_PI * 18)) * 60
          const fade = Math.sin(Math.PI * ratio)
          const target = Math.min(frames - 1, cursor + i)
          channel[target] += Math.sin((TWO_PI * freq * i) / sampleRate) * fade * 0.5
        }
        cursor += length + Math.floor((0.02 + rand() * 0.05) * sampleRate)
        if (cursor >= frames) break
      }
    }
    for (let i = 0; i < frames; i++) {
      left[i] *= intensity
      right[i] *= intensity
    }
    return [left, right]
  },

  footsteps({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const intensity = clamp01(params.intensity ?? 0.6)
    const stepInterval = Math.max(0.2, 60 / Math.max(30, params.rate ?? 104))
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    let cursor = 0.05 * sampleRate
    let index = 0
    while (cursor < frames) {
      const length = Math.floor(0.12 * sampleRate)
      const thumpLength = Math.floor(0.09 * sampleRate)
      const channel = index % 2 === 0 ? left : right
      const weight = 0.7 + rand() * 0.3
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate
        const burst = (rand() * 2 - 1) * Math.exp(-t * 60) * 0.35
        const thump = Math.sin(TWO_PI * (70 - 18 * t) * t) * Math.exp(-t * 35) * 0.8
        channel[Math.min(frames - 1, Math.floor(cursor) + i)] += (burst + thump) * weight
      }
      cursor += stepInterval * sampleRate
      index++
    }
    for (let i = 0; i < frames; i++) {
      left[i] *= intensity
      right[i] *= intensity
    }
    return [left, right]
  },

  stones({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const intensity = clamp01(params.intensity ?? 0.6)
    const density = Math.max(4, Math.round((params.rate ?? 1) * 40))
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let s = 0; s < density; s++) {
      const at = Math.floor(rand() * frames)
      const pitch = 900 + rand() * 2600
      const length = Math.floor((0.04 + rand() * 0.12) * sampleRate)
      const decay = 0.02 + rand() * 0.08
      const channel = rand() < 0.5 ? left : right
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate
        const body = Math.sin(TWO_PI * pitch * t) * 0.5 + Math.sin(TWO_PI * pitch * 2.7 * t) * 0.2
        const click = (rand() * 2 - 1) * Math.exp(-t * 400) * 0.5
        channel[Math.min(frames - 1, at + i)] += (body * Math.exp(-t / decay) + click) * (0.4 + rand() * 0.6)
      }
    }
    for (let i = 0; i < frames; i++) {
      left[i] *= intensity
      right[i] *= intensity
    }
    return [left, right]
  },

  whoosh({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const intensity = clamp01(params.intensity ?? 0.8)
    const brightness = clamp01(params.brightness ?? 0.5)
    const from = 180 + 400 * brightness
    const to = 2400 + 3500 * brightness
    const curve = sweep(frames, from, to, 3)
    const fall = (ratio) => Math.max(120, curve(Math.min(1, ratio * 1.35)) * (1 - ratio) + 120 * ratio)
    const left = svfBandpass(noise(rand, frames), fall, 3, sampleRate)
    const right = svfBandpass(noise(mulberry32(rand() * 1e9), frames), fall, 3.2, sampleRate)
    const amp = envelope(frames, { attackSec: durationSec * 0.45, decaySec: durationSec * 0.5, curve: 2.2, sampleRate })
    for (let i = 0; i < frames; i++) {
      const pan = 0.5 + 0.5 * Math.sin((Math.PI * i) / frames)
      left[i] *= amp[i] * intensity * (0.4 + 0.6 * pan)
      right[i] *= amp[i] * intensity * (1.0 - 0.6 * pan)
    }
    return [left, right]
  },

  impact({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const weight = clamp01(params.weight ?? 0.7)
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const hitLength = Math.min(frames, Math.floor(0.9 * sampleRate))
    for (let i = 0; i < hitLength; i++) {
      const t = i / sampleRate
      const drop = 120 * Math.exp(-t * 6) + 32
      const body = Math.sin(TWO_PI * drop * t) * Math.exp(-t * (4.5 - weight * 2))
      const crack = (rand() * 2 - 1) * Math.exp(-t * 90) * 0.8
      const rumble = Math.sin(TWO_PI * 41 * t) * Math.exp(-t * 1.6) * 0.5
      const value = body * (0.6 + weight) + crack + rumble
      left[i] += value
      right[i] += value * 0.96
    }
    return [left, right]
  },

  bell({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const base = params.pitch ?? 660
    const partials = [1, 2.76, 5.4, 8.93, 13.34]
    const decays = [1.6, 1.1, 0.7, 0.45, 0.3]
    const gains = [1, 0.6, 0.35, 0.2, 0.1]
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let p = 0; p < partials.length; p++) {
      const freq = base * partials[p]
      if (freq > sampleRate * 0.45) continue
      const phaseOffset = rand() * 0.1
      for (let i = 0; i < frames; i++) {
        const t = i / sampleRate
        const value = Math.sin(TWO_PI * freq * t + phaseOffset) * Math.exp(-t / decays[p]) * gains[p]
        left[i] += value
        right[i] += value * (0.95 + 0.05 * Math.cos(t * 3))
      }
    }
    return [left, right]
  },

  gong({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const base = params.pitch ?? 96
    const partials = [1, 2.01, 3.41, 5.19, 7.42, 9.8]
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const swell = Math.min(frames, Math.floor(0.35 * sampleRate))
    for (let p = 0; p < partials.length; p++) {
      const freq = base * partials[p]
      if (freq > sampleRate * 0.45) continue
      const gain = 1 / (p + 1)
      for (let i = 0; i < frames; i++) {
        const t = i / sampleRate
        const attack = i < swell ? i / swell : 1
        const value = Math.sin(TWO_PI * freq * t) * Math.exp(-t / (3.5 - p * 0.35)) * gain * attack
        left[i] += value
        right[i] += value * 0.97
      }
    }
    return [left, right]
  },

  drum({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const base = params.pitch ?? 110
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate
      const freq = base * (0.72 + 0.28 * Math.exp(-t * 18))
      const body = Math.sin(TWO_PI * freq * t) * Math.exp(-t * 7)
      const skin = (rand() * 2 - 1) * Math.exp(-t * 55) * 0.35
      left[i] = body + skin
      right[i] = (body + skin) * 0.97
    }
    return [left, right]
  },

  riser({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const pitch = params.pitch ?? 220
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const tone = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const ratio = i / frames
      const freq = pitch * Math.pow(8, ratio * ratio)
      tone[i] = Math.sin((TWO_PI * freq * i) / sampleRate) * 0.35
    }
    const swell = lowpass(highpass(noise(rand, frames), 400, sampleRate), 8000, sampleRate)
    const swellR = lowpass(highpass(noise(mulberry32(rand() * 1e9), frames), 400, sampleRate), 8000, sampleRate)
    for (let i = 0; i < frames; i++) {
      const ratio = i / frames
      const amp = Math.pow(ratio, 2.2) * 1.2
      left[i] = (tone[i] + swell[i] * 0.6) * amp
      right[i] = (tone[i] + swellR[i] * 0.6) * amp
    }
    return [left, right]
  },

  heartbeat({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const bpm = Math.max(40, Math.min(180, params.rate ?? 70))
    const beat = 60 / bpm
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    let cursor = 0
    while (cursor < durationSec) {
      for (const [offset, gain] of [[0, 1], [0.16, 0.7]]) {
        const at = Math.floor((cursor + offset) * sampleRate)
        const length = Math.floor(0.18 * sampleRate)
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate
          const freq = 58 * (1 + 0.6 * Math.exp(-t * 30))
          const value = Math.sin(TWO_PI * freq * t) * Math.exp(-t * 22) * gain
          const target = Math.min(frames - 1, at + i)
          if (target >= 0) left[target] += value
          if (target >= 0) right[target] += value * 0.95
        }
      }
      cursor += beat
    }
    return [left, right]
  },

  thunder({ durationSec, sampleRate, rand, params }) {
    const frames = Math.ceil(durationSec * sampleRate)
    const weight = clamp01(params.weight ?? 0.8)
    const crack = highpass(noise(rand, frames), 800, sampleRate)
    const rumbleSource = lowpass(noise(mulberry32(rand() * 1e9), frames), 120, sampleRate, 3)
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const modulation = gustCurve(frames, sampleRate, rand, 0.6, 0.7)
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate
      const crackEnv = Math.exp(-t * 9) * 0.7
      const rumbleEnv = Math.exp(-t * 0.7) * (0.5 + weight * 0.8) * modulation[i]
      left[i] = crack[i] * crackEnv + rumbleSource[i] * rumbleEnv
      right[i] = crack[i] * crackEnv * 0.94 + rumbleSource[i] * rumbleEnv
    }
    return [left, right]
  },
}

export const SFX_TYPES = Object.keys(GENERATORS)

function clamp01(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0.6
  return Math.max(0, Math.min(1, parsed))
}

export function synthesizeSfx({ type, durationSec, sampleRate = 48000, params = {}, seed = 1 }) {
  const generator = GENERATORS[type]
  if (!generator) throw new Error(`unknown sfx type "${type}"; available: ${SFX_TYPES.join(', ')}`)
  const frames = Math.ceil(durationSec * sampleRate)
  const rand = mulberry32(seed)
  const [left, right] = generator({ durationSec, sampleRate, rand, params })
  const out = [left.subarray(0, frames), right.subarray(0, frames)]
  return out.map((channel) => normalize(Float32Array.from(channel), 0.85))
}

/**
 * Which spec §5.2 layer a sound belongs to, so the Agent can split the result
 * across tracks without judging each sound by taste.
 *
 * The three layers are the spec's own: 环境音 beds, 动效 things that happen,
 * 其他 transitions and stingers.
 */
export const SFX_CATEGORY = {
  wind: '环境音',
  rain: '环境音',
  water: '环境音',
  fire: '环境音',
  birds: '环境音',
  thunder: '环境音',
  footsteps: '动效',
  stones: '动效',
  impact: '动效',
  bell: '动效',
  gong: '动效',
  drum: '动效',
  heartbeat: '动效',
  whoosh: '其他',
  riser: '其他',
}

/** Preset groups that describe a layer rather than a single generator. */
const GROUP_CATEGORY = {
  weather: '环境音',
  noise: '其他',
  animals: '动效',
  home: '动效',
  traffic: '动效',
  crowd: '动效',
  weapons: '动效',
}

export function categoryOf({ type, group } = {}) {
  if (group && GROUP_CATEGORY[group]) return GROUP_CATEGORY[group]
  if (type && SFX_CATEGORY[type]) return SFX_CATEGORY[type]
  return '动效'
}

/**
 * Render one sound effect as its own short buffer starting at t=0 (plan M7).
 *
 * This is the "materials" half of `anyaudio_sfx`: the tool produces sound
 * material and the project file decides where it sits. Placement is deliberately
 * absent here — that separation is the point of the split.
 */
export function renderSfxMaterial({ type, durationSec, sampleRate = 48000, params = {}, seed = 1, gainDb = 0 }) {
  const channels = synthesizeSfx({ type, durationSec, sampleRate, params, seed })
  const gain = Number.isFinite(Number(gainDb)) ? Math.pow(10, Number(gainDb) / 20) : 1
  const scaled = gain === 1
    ? channels
    : channels.map((channel) => {
      const out = new Float32Array(channel.length)
      for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain
      return out
    })
  return [scaled[0], scaled[1] ?? scaled[0]]
}
