/**
 * Waveform peak cache: fixed-density min/max buckets, one JSON file per material
 * next to the audio (spec §6.1, §14.3; plan M1).
 *
 * Density is 50 buckets per second, not 100: a 15-minute material is 45 000
 * buckets instead of 90 000, and the front end aggregates for zoom instead of
 * asking for a finer level (plan M1).
 */
import { readFile, writeFile } from 'node:fs/promises'

export const BUCKETS_PER_SECOND = 50

export function bucketCount(durationSec) {
  const seconds = Number(durationSec)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.ceil(seconds * BUCKETS_PER_SECOND)
}

/**
 * Build the peak series for float channels. Each bucket holds the signed
 * extremes of both channels merged: the renderer draws one shape per track, so
 * separate channels would only add data no view consumes.
 *
 * `analyze` is the same walk with the square sum accumulated beside it, which is
 * how a material gets its level for free when it is imported (improvement plan
 * 03, I-37). Returns `{ peaks, peakDb, rmsDb }`; a channel set that is pure
 * digital silence reports `null` for both, because −Infinity is not JSON and
 * `null` reads honestly as "nothing there".
 */
export function analyzeChannels(channels, durationSec, { bucketsPerSecond = BUCKETS_PER_SECOND } = {}) {
  const frames = channels?.[0]?.length ?? 0
  if (!frames) throw new Error('computePeaks needs at least one non-empty channel')
  const total = Math.max(1, Math.ceil((Number(durationSec) || frames / 48000) * bucketsPerSecond))
  const framesPerBucket = frames / total
  const min = new Array(total)
  const max = new Array(total)
  let peak = 0
  let squares = 0
  let samples = 0
  for (let bucket = 0; bucket < total; bucket++) {
    const start = Math.floor(bucket * framesPerBucket)
    const end = bucket === total - 1 ? frames : Math.min(frames, Math.floor((bucket + 1) * framesPerBucket))
    let low = 0
    let high = 0
    for (let i = start; i < end; i++) {
      for (const channel of channels) {
        const value = channel[i]
        if (value < low) low = value
        if (value > high) high = value
        const magnitude = value < 0 ? -value : value
        if (magnitude > peak) peak = magnitude
        squares += value * value
        samples++
      }
    }
    min[bucket] = Number(low.toFixed(4))
    max[bucket] = Number(high.toFixed(4))
  }
  const rms = samples > 0 ? Math.sqrt(squares / samples) : 0
  return {
    peaks: { bucketsPerSecond, buckets: total, durationSec: Number(durationSec), min, max },
    peakDb: peak > 0 ? Number((20 * Math.log10(peak)).toFixed(2)) : null,
    rmsDb: rms > 0 ? Number((20 * Math.log10(rms)).toFixed(3)) : null,
  }
}

/** The peak series alone; `analyzeChannels` does the same walk with the level. */
export function computePeaks(channels, durationSec, options) {
  return analyzeChannels(channels, durationSec, options).peaks
}

/** Round the series so the JSON files stay small; the drawing does not need more. */
export function peaksPathFor(materialFileRelPath, materialId) {
  const normalized = String(materialFileRelPath).replace(/\\/g, '/')
  const dir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
  return dir ? `${dir}/${materialId}.peaks.json` : `${materialId}.peaks.json`
}

export async function writePeaks(path, series) {
  await writeFile(path, `${JSON.stringify(series)}\n`, 'utf8')
  return series
}

export async function readPeaks(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(raw?.min) || !Array.isArray(raw?.max) || raw.min.length !== raw.max.length) {
    throw new Error(`${path} is not a valid peaks file`)
  }
  return raw
}
