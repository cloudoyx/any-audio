#!/usr/bin/env node
/**
 * Compares two WAV files with simple spectral/loudness statistics.
 * Usage: node test/timbre.mjs <a.wav> <b.wav>
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseWav, peakOf, rmsOf, toDb } from '../src/audio/wav.js'

const FRAME = 2048
const HOP = 1024

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + len / 2] = aRe - bRe
        im[i + k + len / 2] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

function analyse(path) {
  const wav = parseWav(readFileSync(path))
  const mono = new Float32Array(wav.frames)
  for (let i = 0; i < wav.frames; i++) {
    let sum = 0
    for (const channel of wav.channels) sum += channel[i]
    mono[i] = sum / wav.channels.length
  }
  const window = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  let centroidSum = 0
  let highSum = 0
  let flatnessSum = 0
  let frames = 0
  for (let start = 0; start + FRAME <= mono.length; start += HOP) {
    let energy = 0
    for (let i = 0; i < FRAME; i++) {
      const value = mono[start + i] * window[i]
      re[i] = value
      im[i] = 0
      energy += value * value
    }
    if (energy < 1e-6) continue
    fft(re, im)
    let weighted = 0
    let magnitudeSum = 0
    let high = 0
    let logSum = 0
    let bins = 0
    for (let bin = 1; bin < FRAME / 2; bin++) {
      const frequency = (bin * wav.sampleRate) / FRAME
      const magnitude = Math.hypot(re[bin], im[bin])
      weighted += frequency * magnitude
      magnitudeSum += magnitude
      if (frequency > 4000) high += magnitude
      logSum += Math.log(magnitude + 1e-9)
      bins++
    }
    centroidSum += weighted / magnitudeSum
    highSum += high / magnitudeSum
    flatnessSum += Math.exp(logSum / bins) / (magnitudeSum / bins)
    frames++
  }
  let correlation = 0
  if (wav.channels.length === 2) {
    let dot = 0
    let left = 0
    let right = 0
    for (let i = 0; i < wav.frames; i++) {
      dot += wav.channels[0][i] * wav.channels[1][i]
      left += wav.channels[0][i] ** 2
      right += wav.channels[1][i] ** 2
    }
    correlation = dot / Math.sqrt(left * right || 1)
  }
  return {
    file: basename(path),
    seconds: wav.durationSec,
    peakDb: toDb(peakOf(wav.channels)),
    rmsDb: toDb(rmsOf(wav.channels)),
    crestDb: toDb(peakOf(wav.channels)) - toDb(rmsOf(wav.channels)),
    centroidHz: Math.round(centroidSum / Math.max(1, frames)),
    highBandRatio: +(highSum / Math.max(1, frames)).toFixed(3),
    flatness: +(flatnessSum / Math.max(1, frames)).toFixed(5),
    channelCorrelation: +correlation.toFixed(2),
  }
}

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  console.error('usage: node test/timbre.mjs <a.wav> <b.wav>')
  process.exit(2)
}
console.table([analyse(a), analyse(b)])
