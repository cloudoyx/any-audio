/**
 * Waveform geometry (plan M5.2).
 *
 * Peaks arrive at a fixed density (50 buckets per second, one file per material).
 * Zooming must never ask for a finer series — it aggregates the same buckets onto
 * fewer pixels, and zooming in re-reads the buckets already loaded. This module is
 * the pure geometry layer: given a peak series, the source range of a clip and the
 * pixel width it occupies, produce the min/max pairs to draw.
 */

/**
 * Aggregate a peak series down to `columns` column pairs.
 *
 * `fromBucket`/`toBucket` are the slice of the series the clip covers (its in/out
 * range), so a trimmed clip draws only its own part of the waveform. When there
 * are more buckets than columns we take the extremes of each group; when there
 * are fewer, columns repeat the nearest bucket — the shape stays correct at any
 * zoom, which is the point.
 */
export function columnsFor(peaks, fromBucket, toBucket, columns) {
  const count = Math.max(0, Math.floor(columns))
  if (!count) return []

  const min = peaks?.min
  const max = peaks?.max
  const total = Array.isArray(min) && Array.isArray(max) ? Math.min(min.length, max.length) : 0
  if (!total) return []

  const start = Math.max(0, Math.min(total, Math.floor(fromBucket)))
  const end = Math.max(start, Math.min(total, Math.ceil(toBucket)))
  const span = end - start
  if (span <= 0) return []

  const out = new Array(count)
  for (let column = 0; column < count; column++) {
    const bucketStart = start + Math.floor((column * span) / count)
    const bucketEnd = start + Math.floor(((column + 1) * span) / count)
    let low = 0
    let high = 0
    if (bucketEnd <= bucketStart) {
      const value = start + Math.min(span - 1, Math.floor((column * span) / count))
      low = min[value]
      high = max[value]
    } else {
      for (let bucket = bucketStart; bucket < bucketEnd; bucket++) {
        if (min[bucket] < low) low = min[bucket]
        if (max[bucket] > high) high = max[bucket]
      }
    }
    out[column] = { min: low, max: high }
  }
  return out
}

/** Which buckets a clip's in/out range covers in its material's peak series. */
export function bucketsForRange(peaks, inSec, outSec) {
  const rate = Number(peaks?.bucketsPerSecond) || 0
  if (!(rate > 0)) return { fromBucket: 0, toBucket: 0 }
  return {
    fromBucket: Math.max(0, Number(inSec) * rate),
    toBucket: Math.max(0, Number(outSec) * rate),
  }
}

/**
 * Draw one clip's waveform into its own box.
 *
 * `scale` maps seconds to pixels; the caller positions the canvas on the clip, so
 * this only ever sees the clip's own width. The centre line is drawn even for a
 * silent clip, otherwise an empty track looks broken rather than quiet.
 */
export function drawClipWaveform(ctx, { peaks, inSec, outSec, width, height, color = 'rgba(255,255,255,0.55)' }) {
  if (!ctx || !(width > 0) || !(height > 0)) return
  const middle = height / 2
  ctx.clearRect(0, 0, width, height)

  const range = bucketsForRange(peaks, inSec, outSec)
  const columns = columnsFor(peaks, range.fromBucket, range.toBucket, width)
  if (columns.length === 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.beginPath()
    ctx.moveTo(0, middle)
    ctx.lineTo(width, middle)
    ctx.stroke()
    return
  }

  ctx.fillStyle = color
  const half = middle - 1
  for (let column = 0; column < columns.length; column++) {
    const low = columns[column].min
    const high = columns[column].max
    const top = middle - Math.min(1, Math.abs(high)) * half
    const bottom = middle + Math.min(1, Math.abs(low)) * half
    ctx.fillRect(column, top, 1, Math.max(1, bottom - top))
  }
}

/** The peak series drawn small, for a project list thumbnail or a test. */
export function envelopeOf(peaks, columns = 64) {
  const total = Math.min(peaks?.min?.length ?? 0, peaks?.max?.length ?? 0)
  return columnsFor(peaks, 0, total, columns)
}
