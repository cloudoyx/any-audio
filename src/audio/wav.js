const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe

export class AudioFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioFormatError'
  }
}

/**
 * Decode a RIFF/WAVE file into float channels.
 * Supports PCM 8/16/24/32-bit, IEEE float 32/64-bit and WAVE_FORMAT_EXTENSIBLE.
 */
export function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioFormatError('not a RIFF/WAVE file')
  }
  let fmt = null
  let data = null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    let size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > buffer.length) {
      if (id === 'data') size = buffer.length - body
      else break
    }
    if (id === 'fmt ') fmt = readFormat(buffer, body, size)
    else if (id === 'data') data = { offset: body, size }
    offset = body + size + (size % 2)
    if (fmt && data) break
  }
  if (!fmt) throw new AudioFormatError('missing fmt chunk')
  if (!data || data.size === 0) throw new AudioFormatError('missing or empty data chunk')
  if (fmt.channels < 1 || fmt.channels > 16) throw new AudioFormatError(`unsupported channel count: ${fmt.channels}`)
  if (!Number.isFinite(fmt.sampleRate) || fmt.sampleRate < 8000 || fmt.sampleRate > 384000) {
    throw new AudioFormatError(`unsupported sample rate: ${fmt.sampleRate}`)
  }

  const bytesPerSample = fmt.bitsPerSample / 8
  const frameSize = bytesPerSample * fmt.channels
  const frames = Math.floor(data.size / frameSize)
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++) {
    const base = data.offset + i * frameSize
    for (let ch = 0; ch < fmt.channels; ch++) {
      const p = base + ch * bytesPerSample
      channels[ch][i] = readSample(buffer, p, fmt)
    }
  }
  return {
    sampleRate: fmt.sampleRate,
    channels,
    bitsPerSample: fmt.bitsPerSample,
    frames,
    durationSec: frames / fmt.sampleRate,
  }
}

function readFormat(buffer, body, size) {
  if (size < 16) throw new AudioFormatError('fmt chunk too short')
  const format = buffer.readUInt16LE(body)
  const channels = buffer.readUInt16LE(body + 2)
  const sampleRate = buffer.readUInt32LE(body + 4)
  const bitsPerSample = buffer.readUInt16LE(body + 14)
  let effective = format
  if (format === FORMAT_EXTENSIBLE && size >= 26) effective = buffer.readUInt16LE(body + 24)
  if (effective !== FORMAT_PCM && effective !== FORMAT_FLOAT) {
    throw new AudioFormatError(`unsupported WAV encoding (format tag ${format})`)
  }
  if (effective === FORMAT_PCM && ![8, 16, 24, 32].includes(bitsPerSample)) {
    throw new AudioFormatError(`unsupported PCM bit depth: ${bitsPerSample}`)
  }
  if (effective === FORMAT_FLOAT && ![32, 64].includes(bitsPerSample)) {
    throw new AudioFormatError(`unsupported float bit depth: ${bitsPerSample}`)
  }
  return { format: effective, channels, sampleRate, bitsPerSample }
}

function readSample(buffer, p, fmt) {
  if (fmt.format === FORMAT_FLOAT) {
    return fmt.bitsPerSample === 32 ? buffer.readFloatLE(p) : buffer.readDoubleLE(p)
  }
  switch (fmt.bitsPerSample) {
    case 8:
      return (buffer.readUInt8(p) - 128) / 128
    case 16:
      return buffer.readInt16LE(p) / 32768
    case 24: {
      let value = buffer.readUIntLE(p, 3)
      if (value & 0x800000) value -= 0x1000000
      return value / 8388608
    }
    default:
      return buffer.readInt32LE(p) / 2147483648
  }
}

/** Encode float channels as a 16-bit PCM (default) or 32-bit float WAV. */
export function encodeWav({ sampleRate, channels, bitDepth = 16 }) {
  if (!channels.length) throw new AudioFormatError('cannot encode zero channels')
  const frames = channels[0].length
  const channelCount = channels.length
  const float = bitDepth === 32
  const bytesPerSample = float ? 4 : 2
  const dataSize = frames * channelCount * bytesPerSample
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(float ? FORMAT_FLOAT : FORMAT_PCM, 20)
  header.writeUInt16LE(channelCount, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28)
  header.writeUInt16LE(channelCount * bytesPerSample, 32)
  header.writeUInt16LE(bytesPerSample * 8, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)
  const body = Buffer.alloc(dataSize)
  let p = 0
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const sample = Number.isFinite(channels[ch][i]) ? channels[ch][i] : 0
      if (float) {
        body.writeFloatLE(sample, p)
      } else {
        const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample
        body.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), p)
      }
      p += bytesPerSample
    }
  }
  return Buffer.concat([header, body])
}

/**
 * Windowed-sinc resampling. Used only when a source file's rate differs from
 * the mix rate; linear interpolation would audibly alias on music material.
 */
export function resample(channels, fromRate, toRate) {
  if (fromRate === toRate) return channels
  const ratio = toRate / fromRate
  const outFrames = Math.max(1, Math.round(channels[0].length * ratio))
  return channels.map((src) => resampleChannel(src, ratio, outFrames))
}

function resampleChannel(src, ratio, outFrames) {
  const out = new Float32Array(outFrames)
  const cutoff = Math.min(1, ratio)
  const taps = 12
  for (let i = 0; i < outFrames; i++) {
    const x = i / ratio
    const center = Math.floor(x)
    let sum = 0
    let weight = 0
    for (let k = center - taps + 1; k <= center + taps; k++) {
      if (k < 0 || k >= src.length) continue
      const d = x - k
      const arg = Math.PI * d * cutoff
      const sinc = d === 0 ? 1 : Math.sin(arg) / arg
      const window = Math.abs(d) >= taps ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * d) / taps) + 0.08 * Math.cos((2 * Math.PI * d) / taps)
      const coefficient = sinc * window
      sum += src[k] * coefficient
      weight += coefficient
    }
    out[i] = weight !== 0 ? sum / weight : 0
  }
  return out
}

export function peakOf(channels) {
  let peak = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i])
      if (value > peak) peak = value
    }
  }
  return peak
}

export function rmsOf(channels, start = 0, end = Infinity) {
  let sum = 0
  let count = 0
  for (const channel of channels) {
    const last = Math.min(channel.length, end)
    for (let i = Math.max(0, start); i < last; i++) {
      sum += channel[i] * channel[i]
      count++
    }
  }
  return count ? Math.sqrt(sum / count) : 0
}

export function toDb(linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity
}

export function fromDb(db) {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0
}

/** Mix every input channel set down to the given channel count. */
export function conformChannels(channels, target = 2) {
  if (channels.length === target) return channels
  if (channels.length === 1 && target === 2) return [channels[0], channels[0]]
  const mono = new Float32Array(channels[0].length)
  const scale = 1 / channels.length
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] * scale
  }
  if (target === 1) return [mono]
  return Array.from({ length: target }, () => Float32Array.from(mono))
}

export function padOrTrim(channels, frames) {
  return channels.map((channel) => {
    if (channel.length === frames) return channel
    const out = new Float32Array(frames)
    out.set(channel.subarray(0, Math.min(channel.length, frames)))
    return out
  })
}
