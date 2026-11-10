/**
 * Waveform geometry (plan M5.2).
 *
 * Pure maths, no DOM: the drawing wrapper at the bottom takes a context so the
 * same code runs in the browser and under a stub in the test suite.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'waveform.js'), 'utf8')
const { columnsFor, bucketsForRange, drawClipWaveform, envelopeOf } = await import(
  `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
)

let passed = 0
let failed = 0

function test(name, run) {
  try {
    run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${error.message}`)
  }
}

function check(condition, message) {
  assert.ok(condition, message)
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
}

/** A 10 Hz series whose amplitude ramps from 0 to 1 over one second. */
function rampPeaks(seconds = 1, rate = 50) {
  const buckets = Math.round(seconds * rate)
  const min = []
  const max = []
  for (let i = 0; i < buckets; i++) {
    const amplitude = i / (buckets - 1)
    max.push(Number(amplitude.toFixed(4)))
    min.push(Number((-amplitude).toFixed(4)))
  }
  return { bucketsPerSecond: rate, buckets, durationSec: seconds, min, max }
}

test('columnsFor aggregates a wide series down to the pixel width', () => {
  const peaks = rampPeaks(1, 50)
  const columns = columnsFor(peaks, 0, peaks.buckets, 10)
  equal(columns.length, 10, 'one pair per column')
  check(columns[0].max <= columns[1].max, 'the ramp must stay increasing')
  check(Math.abs(columns[9].max - 1) < 0.06, 'the last column must reach the peak')
})

test('columnsFor keeps the extremes instead of averaging them away', () => {
  // Alternating full-scale and silent buckets: averaging would flatten it to 0.5,
  // taking the extremes must keep the full 1.0 peak.
  const min = []
  const max = []
  for (let i = 0; i < 40; i++) {
    max.push(i % 2 === 0 ? 1 : 0)
    min.push(i % 2 === 0 ? -1 : 0)
  }
  const columns = columnsFor({ min, max, bucketsPerSecond: 50 }, 0, 40, 4)
  equal(columns.length, 4)
  for (const column of columns) {
    equal(column.max, 1, 'a peak must not be averaged into the floor')
    equal(column.min, -1, 'a trough must not be averaged into the floor')
  }
})

test('columnsFor repeats buckets when pixels outnumber buckets (zooming in)', () => {
  const min = [0.5, 0.9]
  const max = [0.6, 1]
  const columns = columnsFor({ min, max, bucketsPerSecond: 50 }, 0, 2, 8)
  equal(columns.length, 8, 'every pixel gets a column')
  for (const column of columns) {
    check(column.max === 0.6 || column.max === 1, 'a zoomed column must be one of the real buckets')
  }
})

test('columnsFor respects the clip in/out range', () => {
  const min = []
  const max = []
  for (let i = 0; i < 100; i++) {
    const inside = i >= 20 && i < 40 ? 1 : 0.01
    max.push(inside)
    min.push(-inside)
  }
  const peaks = { min, max, bucketsPerSecond: 50 }
  const columns = columnsFor(peaks, 20, 40, 4)
  equal(columns.length, 4)
  for (const column of columns) equal(column.max, 1, 'only the in/out window is drawn')
})

test('columnsFor returns nothing for an empty or missing series', () => {
  equal(columnsFor(null, 0, 10, 5), [])
  equal(columnsFor({ min: [], max: [] }, 0, 0, 5), [])
  equal(columnsFor({ min: [0], max: [0] }, 0, 1, 0), [])
})

test('columnsFor clamps a range that runs past the series', () => {
  const peaks = rampPeaks(1, 50)
  const columns = columnsFor(peaks, -10, 999, 5)
  equal(columns.length, 5, 'an out-of-range window still draws the part that exists')
})

test('bucketsForRange converts seconds to buckets without resampling', () => {
  const peaks = { bucketsPerSecond: 50 }
  equal(bucketsForRange(peaks, 0, 2), { fromBucket: 0, toBucket: 100 })
  equal(bucketsForRange(peaks, 1.5, 2.25), { fromBucket: 75, toBucket: 112.5 })
  equal(bucketsForRange({ bucketsPerSecond: 0 }, 0, 2), { fromBucket: 0, toBucket: 0 })
  equal(bucketsForRange(null, 0, 2), { fromBucket: 0, toBucket: 0 })
})

test('drawClipWaveform fills one bar per column and nothing else', () => {
  const calls = { fillRect: [], clearRect: [], stroke: 0 }
  const ctx = {
    clearRect: (...args) => calls.clearRect.push(args),
    fillRect: (...args) => calls.fillRect.push(args),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => { calls.stroke++ },
    set fillStyle(value) { calls.fillStyle = value },
    set strokeStyle(value) { calls.strokeStyle = value },
  }
  const peaks = rampPeaks(1, 50)
  drawClipWaveform(ctx, { peaks, inSec: 0, outSec: 1, width: 20, height: 40 })
  equal(calls.clearRect.length, 1, 'the old frame is cleared exactly once')
  equal(calls.fillRect.length, 20, 'one bar per pixel column')
  equal(calls.stroke, 0, 'a drawable clip must not fall back to the flat line')
  for (const [, top, width, height] of calls.fillRect) {
    equal(width, 1, 'each bar is one pixel wide')
    check(height >= 1, 'a bar is never zero height')
    check(top >= 0 && top <= 40, 'bars stay inside the box')
  }
})

test('drawClipWaveform draws a centre line when there is no series', () => {
  const calls = { stroke: 0, fillRect: 0 }
  const ctx = {
    clearRect: () => {},
    fillRect: () => { calls.fillRect++ },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => { calls.stroke++ },
    set fillStyle(v) {},
    set strokeStyle(v) {},
  }
  drawClipWaveform(ctx, { peaks: null, inSec: 0, outSec: 1, width: 20, height: 40 })
  equal(calls.stroke, 1, 'an empty clip still gets its centre line')
  equal(calls.fillRect, 0, 'nothing is filled')
})

test('drawClipWaveform ignores a zero-sized box', () => {
  let touched = false
  const ctx = { clearRect: () => { touched = true }, fillRect: () => { touched = true } }
  drawClipWaveform(ctx, { peaks: rampPeaks(1, 50), inSec: 0, outSec: 1, width: 0, height: 40 })
  drawClipWaveform(ctx, { peaks: rampPeaks(1, 50), inSec: 0, outSec: 1, width: 20, height: 0 })
  drawClipWaveform(null, { peaks: rampPeaks(1, 50), inSec: 0, outSec: 1, width: 20, height: 40 })
  equal(touched, false, 'a collapsed clip must not draw')
})

test('envelopeOf summarises a whole material', () => {
  const peaks = rampPeaks(2, 50)
  const columns = envelopeOf(peaks, 16)
  equal(columns.length, 16)
  check(columns[15].max > columns[0].max, 'the envelope follows the material')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
