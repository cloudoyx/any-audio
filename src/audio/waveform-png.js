/**
 * A waveform thumbnail, drawn as a PNG with no image library.
 *
 * The agent has no ears. A name says what a sound is; it cannot say whether the
 * sound is a single hit or a run of them, where the peak sits, or whether it
 * decays. A picture says exactly that, and it is the only non-text hint this
 * plugin can give.
 *
 * Two constraints come from the host, not from taste:
 *
 * - the PNG must be **RGB (colorType 2)**. A greyscale PNG is not `srgb`, so the
 *   attachment service re-encodes it as JPEG — measured at 575 B → 5120 B for the
 *   same pixels. Three identical channels cost a few hundred bytes and keep the
 *   file as it was drawn.
 * - the size is **1024×256**. Below 544×544 the vision pricing scales the image
 *   up anyway, so 512×128 and 1024×256 cost the same tokens while the wider one
 *   resolves twice as much time.
 *
 * Nothing is cached on disk: a thumbnail takes tens of milliseconds to draw, and
 * 237 of them would add megabytes to a pack that is meant to be audio only.
 */
import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index++) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Encode raw RGB pixels as a PNG.
 *
 * `pixels` is `width * height * 3` bytes, row-major. Every scanline gets filter
 * type 0 (none): the image is a waveform on a flat background, and a filter
 * would cost more to compute than it saves in the deflate stream.
 */
export function encodePng({ width, height, pixels }) {
  if (!Number.isInteger(width) || width <= 0) throw new Error('width must be a positive integer')
  if (!Number.isInteger(height) || height <= 0) throw new Error('height must be a positive integer')
  if (pixels.length !== width * height * 3) {
    throw new Error(`pixels must be ${width * height * 3} bytes, got ${pixels.length}`)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour RGB
  header[10] = 0 // compression
  header[11] = 0 // filter
  header[12] = 0 // interlace

  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const BACKGROUND = [16, 16, 20]
const WAVE = [232, 232, 240]
const CENTRE = [48, 48, 64]

/**
 * Draw one waveform.
 *
 * Each column takes the minimum and the maximum of the samples that fall in it,
 * so a transient stays a spike and a sustained bed stays a band. The whole image
 * is normalised to its own peak: a forest ambience measured at −44 dBFS would
 * otherwise be a flat line, which tells the agent nothing.
 */
export function drawWaveform({ samples, width = 1024, height = 256 }) {
  if (!samples || samples.length === 0) throw new Error('a waveform needs at least one sample')
  const pixels = Buffer.alloc(width * height * 3)
  for (let index = 0; index < width * height; index++) {
    pixels[index * 3] = BACKGROUND[0]
    pixels[index * 3 + 1] = BACKGROUND[1]
    pixels[index * 3 + 2] = BACKGROUND[2]
  }

  let peak = 0
  for (const value of samples) {
    const magnitude = value < 0 ? -value : value
    if (magnitude > peak) peak = magnitude
  }
  const scale = peak > 0 ? 1 / peak : 0
  const middle = (height - 1) / 2
  const half = middle

  const perColumn = samples.length / width
  for (let column = 0; column < width; column++) {
    const start = Math.floor(column * perColumn)
    const end = column === width - 1 ? samples.length : Math.max(start + 1, Math.floor((column + 1) * perColumn))
    let low = 0
    let high = 0
    for (let index = start; index < end && index < samples.length; index++) {
      const value = samples[index] * scale
      if (value < low) low = value
      if (value > high) high = value
    }
    const top = Math.round(middle - high * half)
    const bottom = Math.round(middle - low * half)
    for (let row = Math.max(0, top); row <= Math.min(height - 1, bottom); row++) {
      const offset = (row * width + column) * 3
      pixels[offset] = WAVE[0]
      pixels[offset + 1] = WAVE[1]
      pixels[offset + 2] = WAVE[2]
    }
  }

  // A centre line, so a silent stretch still reads as "silence" rather than as
  // "the image failed to load".
  const centreRow = Math.round(middle)
  for (let column = 0; column < width; column++) {
    const offset = (centreRow * width + column) * 3
    if (pixels[offset] === BACKGROUND[0] && pixels[offset + 1] === BACKGROUND[1]) {
      pixels[offset] = CENTRE[0]
      pixels[offset + 1] = CENTRE[1]
      pixels[offset + 2] = CENTRE[2]
    }
  }

  return encodePng({ width, height, pixels })
}

/** The peak position in seconds, from the same samples the picture is drawn from. */
export function peakPositionSec(samples, sampleRate) {
  if (!samples || samples.length === 0 || !(sampleRate > 0)) return null
  let peak = 0
  let at = 0
  for (let index = 0; index < samples.length; index++) {
    const magnitude = samples[index] < 0 ? -samples[index] : samples[index]
    if (magnitude > peak) {
      peak = magnitude
      at = index
    }
  }
  return at / sampleRate
}

/** The rate the picture is drawn from. Mono at 32 kHz is plenty for 1024 columns. */
export const WAVEFORM_SAMPLE_RATE = 32000

/**
 * Decode one audio file to mono float samples.
 *
 * The library holds MP3 and the project's own reader only understands WAV, so
 * the picture cannot come from `parseWav`. ffmpeg decodes to raw PCM on stdout,
 * which is one process and no temporary file.
 */
export function decodeMonoSamples(ffmpegCommand, file, { signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(ffmpegCommand, [
        '-hide_banner', '-loglevel', 'error',
        '-i', file,
        '-f', 's16le', '-acodec', 'pcm_s16le',
        '-ac', '1', '-ar', String(WAVEFORM_SAMPLE_RATE),
        '-',
      ], { windowsHide: true, signal })
      const chunks = []
      let stderr = ''
      child.stdout?.on('data', (chunk) => chunks.push(chunk))
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg could not decode ${file}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`))
          return
        }
        const buffer = Buffer.concat(chunks)
        const count = Math.floor(buffer.length / 2)
        const samples = new Float32Array(count)
        for (let index = 0; index < count; index++) samples[index] = buffer.readInt16LE(index * 2) / 32768
        resolvePromise(samples)
      })
    }, reject)
  })
}
