/**
 * Playback scheduling (plan M5.3).
 *
 * The point of testing this without a browser is that the numbers must match the
 * renderer exactly: if preview and export disagree about gain or offset, the user
 * hears one thing and exports another.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'audio.js'), 'utf8')
  // The hooks import react, which is not needed for the pure helpers.
  .replace(/^import .*$/gm, '')
  .replace(/export function usePlayback[\s\S]*$/m, '')
const { scheduleClips, audibleTracks, dbToGain, scheduledLength } = await import(
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

function close(actual, expected, message, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: expected ${expected}, got ${actual}`)
}

function track(overrides = {}) {
  return { id: 'trk_1', name: 'T', category: 'other', volumeDb: 0, pan: 0, muted: false, solo: false, items: [], ...overrides }
}

function item(overrides = {}) {
  return {
    id: 'itm_1', material: 'mat_1', startSec: 0, inSec: 0, outSec: 2,
    gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: '', ...overrides,
  }
}

test('dbToGain matches the dB definition, and 0 dB is exactly 1', () => {
  assert.equal(dbToGain(0), 1)
  close(dbToGain(-6), 0.5011872336, '-6 dB is half amplitude')
  close(dbToGain(6), 1.99526231, '+6 dB doubles')
  close(dbToGain(-120), 1e-6, 'silence floor')
})

test('audibleTracks: mute removes a track, solo wins over everything', () => {
  const plain = [track({ id: 'a' }), track({ id: 'b' })]
  assert.deepEqual(audibleTracks(plain).map((t) => t.id), ['a', 'b'])

  const muted = [track({ id: 'a' }), track({ id: 'b', muted: true })]
  assert.deepEqual(audibleTracks(muted).map((t) => t.id), ['a'])

  const solo = [track({ id: 'a' }), track({ id: 'b', solo: true }), track({ id: 'c' })]
  assert.deepEqual(audibleTracks(solo).map((t) => t.id), ['b'], 'solo silences the rest')

  const soloMuted = [track({ id: 'a', solo: true, muted: true }), track({ id: 'b', solo: true })]
  assert.deepEqual(audibleTracks(soloMuted).map((t) => t.id), ['b'], 'a muted solo track is still silent')
})

test('scheduleClips places a clip at its start time', () => {
  const project = { tracks: [track({ items: [item({ startSec: 3, inSec: 1, outSec: 4 })] })] }
  const entries = scheduleClips(project, 0)
  assert.equal(entries.length, 1)
  const entry = entries[0]
  close(entry.when, 3, 'starts at 3s')
  close(entry.inSec, 1, 'reads from the in point')
  close(entry.duration, 3, 'lasts outSec - inSec')
})

test('scheduleClips multiplies track and clip gain', () => {
  const project = { tracks: [track({ volumeDb: -6, items: [item({ gainDb: -3.5 })] })] }
  const entry = scheduleClips(project, 0)[0]
  close(entry.gain, dbToGain(-9.5), 'gains add in dB, not multiply per stage', 1e-9)
})

test('scheduleClips sums clip and track pan, clamped', () => {
  const project = { tracks: [track({ pan: 0.4, items: [item({ pan: 0.4 })] })] }
  close(scheduleClips(project, 0)[0].pan, 0.8, 'pans add')
  const over = { tracks: [track({ pan: 1, items: [item({ pan: 1 })] })] }
  close(scheduleClips(over, 0)[0].pan, 1, 'the sum is clamped to +1')
})

test('scheduleClips skips muted clips and muted tracks', () => {
  const mutedItem = { tracks: [track({ items: [item({ muted: true })] })] }
  assert.equal(scheduleClips(mutedItem, 0).length, 0, 'a muted clip does not play')
  const mutedTrack = { tracks: [track({ muted: true, items: [item()] })] }
  assert.equal(scheduleClips(mutedTrack, 0).length, 0, 'a muted track does not play')
})

test('scheduleClips drops clips that already ended before the playhead', () => {
  const project = { tracks: [track({ items: [item({ startSec: 0, inSec: 0, outSec: 2 })] })] }
  assert.equal(scheduleClips(project, 2).length, 0, 'an ended clip is not scheduled')
  assert.equal(scheduleClips(project, 5).length, 0, 'nor one long past')
})

test('scheduleClips enters a clip mid-way when the playhead is inside it', () => {
  const project = { tracks: [track({ items: [item({ startSec: 2, inSec: 1, outSec: 5, fadeInSec: 1, fadeOutSec: 0.5 })] })] }
  const entry = scheduleClips(project, 3.5)[0]
  close(entry.when, 0, 'it starts immediately')
  close(entry.duration, 2.5, 'only the remainder plays')
  close(entry.inSec, 2.5, 'the in point advances by the skipped part')
  close(entry.fadeInSec, 0, 'the fade-in was already passed')
  close(entry.fadeOutSec, 0.5, 'the fade-out is untouched')
})

test('scheduleClips keeps the part of a fade-in that is still ahead', () => {
  const project = { tracks: [track({ items: [item({ startSec: 0, inSec: 0, outSec: 10, fadeInSec: 4 })] })] }
  const entry = scheduleClips(project, 1)[0]
  close(entry.fadeInSec, 3, 'three seconds of fade remain')
})

test('scheduleClips never fades out longer than the clip plays', () => {
  const project = { tracks: [track({ items: [item({ startSec: 0, inSec: 0, outSec: 2, fadeOutSec: 30 })] })] }
  close(scheduleClips(project, 1.5)[0].fadeOutSec, 0.5, 'the fade is clamped to what is left')
})

test('scheduleClips orders entries by start time', () => {
  const project = {
    tracks: [
      track({ id: 'a', items: [item({ id: 'late', startSec: 8, outSec: 1 })] }),
      track({ id: 'b', items: [item({ id: 'early', startSec: 1, outSec: 1 })] }),
    ],
  }
  assert.deepEqual(scheduleClips(project, 0).map((e) => e.itemId), ['early', 'late'])
})

test('scheduleClips handles a zero-length or inverted range without scheduling it', () => {
  const project = { tracks: [track({ items: [item({ inSec: 2, outSec: 2 })] })] }
  assert.equal(scheduleClips(project, 0).length, 0)
  const inverted = { tracks: [track({ items: [item({ inSec: 3, outSec: 1 })] })] }
  assert.equal(scheduleClips(inverted, 0).length, 0)
})

test('scheduleClips survives an empty project', () => {
  assert.deepEqual(scheduleClips(null, 0), [])
  assert.deepEqual(scheduleClips({ tracks: [] }, 0), [])
  assert.deepEqual(scheduleClips({ tracks: [track()] }, 0), [])
})

test('scheduledLength follows the last clip end', () => {
  const project = {
    tracks: [track({ items: [item({ id: 'a', startSec: 0, outSec: 2 }), item({ id: 'b', startSec: 5, inSec: 0, outSec: 3 })] })],
  }
  const entries = scheduleClips(project, 0)
  close(scheduledLength(entries), 8, 'the transport stops at the last tail')
  close(scheduledLength(scheduleClips(project, 6)), 2, 'and shortens when starting late')
})

test('scheduleClips agrees with a hand-computed renderer mix', () => {
  // Two clips on two tracks, one trimmed, one panned: the export mix of this
  // arrangement is what these four numbers describe.
  const project = {
    tracks: [
      track({ id: 'a', volumeDb: -6, pan: 0, items: [item({ id: 'a1', startSec: 0, inSec: 0.5, outSec: 2.5, gainDb: -1 })] }),
      track({ id: 'b', volumeDb: 0, pan: -1, items: [item({ id: 'b1', startSec: 1, inSec: 0, outSec: 1 })] }),
    ],
  }
  const entries = scheduleClips(project, 0)
  const a = entries.find((e) => e.itemId === 'a1')
  const b = entries.find((e) => e.itemId === 'b1')
  close(a.when, 0, 'a starts at 0')
  close(a.inSec, 0.5, 'a is trimmed in')
  close(a.duration, 2, 'a lasts 2s')
  close(a.gain, dbToGain(-7), 'a carries -7 dB total')
  close(b.when, 1, 'b starts at 1')
  close(b.pan, -1, 'b is hard left')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
