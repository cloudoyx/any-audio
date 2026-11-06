/**
 * Clip operations (plan M5.4).
 *
 * These run in Node so the arithmetic is checked without a browser: the whole
 * point of the module being pure is that a drag can be tested as numbers.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'edit.js'), 'utf8')
const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
const {
  moveClip, trimClip, splitClip, deleteClip, duplicateClip,
  setClipGain, setClipPan, setClipFades, setClipMuted, assertWithinLimits, EditError,
  itemLength, itemEnd,
} = mod

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

function close(actual, expected, message, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${message}: expected ${expected}, got ${actual}`)
}

function item(overrides = {}) {
  return {
    id: 'itm_1', material: 'mat_1', startSec: 4, inSec: 1, outSec: 3,
    gainDb: 0, pan: 0, fadeInSec: 0, fadeOutSec: 0, muted: false, label: 'drums', ...overrides,
  }
}

function project(items = [item()]) {
  return {
    schemaVersion: 1, id: 'prj_edit', name: 'edit', sampleRate: 48000, durationSec: 10,
    normalizeGainDb: 0, masterFaderDb: 0, createdAt: '2026-11-06T00:00:00Z', modifiedAt: '2026-11-06T00:00:00Z',
    history: [], video: null,
    tracks: [{ id: 'trk_1', name: 'Drums', category: 'music', volumeDb: 0, pan: 0, muted: false, solo: false, items }],
  }
}

const first = (result) => result.project.tracks[0].items

test('moveClip changes only the start, leaving length and source range', () => {
  const before = project()
  const { project: after, note } = moveClip(before, { trackId: 'trk_1', itemId: 'itm_1', startSec: 9.5 })
  const moved = after.tracks[0].items[0]
  close(moved.startSec, 9.5, 'new position')
  close(moved.inSec, 1, 'in point untouched')
  close(moved.outSec, 3, 'out point untouched')
  close(itemLength(moved), 2, 'length untouched')
  check(/移动片段/.test(note), 'the note names the operation')
  close(before.tracks[0].items[0].startSec, 4, 'the input project is not mutated')
})

test('moveClip never touches neighbouring clips (no ripple)', () => {
  const before = project([item({ id: 'a', startSec: 0, inSec: 0, outSec: 2 }), item({ id: 'b', startSec: 5, inSec: 0, outSec: 2 })])
  const { project: after } = moveClip(before, { trackId: 'trk_1', itemId: 'a', startSec: 8 })
  const [a, b] = after.tracks[0].items
  close(a.startSec, 8, 'a moved')
  close(b.startSec, 5, 'b did not')
})

test('moveClip refuses nothing but clamps at zero and reports no note for a no-op', () => {
  const before = project()
  const { project: after, note } = moveClip(before, { trackId: 'trk_1', itemId: 'itm_1', startSec: -5 })
  close(after.tracks[0].items[0].startSec, 0, 'a negative drag clamps to the timeline start')
  check(/移动片段/.test(note), 'clamping is still a change')
  const same = moveClip(before, { trackId: 'trk_1', itemId: 'itm_1', startSec: 4 })
  equal(same.note, '', 'moving to the same place records nothing')
})

test('trimClip on the end shortens from the right only', () => {
  const before = project()
  const { project: after } = trimClip(before, { trackId: 'trk_1', itemId: 'itm_1', edge: 'end', deltaSec: -0.5 })
  const trimmed = after.tracks[0].items[0]
  close(trimmed.outSec, 2.5, 'out point moved back')
  close(trimmed.startSec, 4, 'start did not move')
  close(trimmed.inSec, 1, 'in point did not move')
})

test('trimClip on the start keeps the audio anchored on the timeline', () => {
  const before = project()
  const beforeEnd = itemEnd(before.tracks[0].items[0])
  const { project: after } = trimClip(before, { trackId: 'trk_1', itemId: 'itm_1', edge: 'start', deltaSec: 0.5 })
  const trimmed = after.tracks[0].items[0]
  close(trimmed.inSec, 1.5, 'the in point moved into the material')
  close(trimmed.startSec, 4.5, 'the clip starts later by the same amount')
  close(itemEnd(trimmed), beforeEnd, 'the end stayed put, so the audio did not shift')
})

test('trimClip cannot invert the range', () => {
  const before = project()
  const { project: after } = trimClip(before, { trackId: 'trk_1', itemId: 'itm_1', edge: 'end', deltaSec: -99 })
  const trimmed = after.tracks[0].items[0]
  check(trimmed.outSec > trimmed.inSec, 'the range stays positive')
  check(itemLength(trimmed) >= 0.05, 'the minimum length is respected')
})

test('trimClip on the start cannot run past the end', () => {
  const before = project()
  const { project: after } = trimClip(before, { trackId: 'trk_1', itemId: 'itm_1', edge: 'start', deltaSec: 99 })
  const trimmed = after.tracks[0].items[0]
  check(trimmed.inSec < trimmed.outSec, 'the range stays positive')
})

test('trimClip reports no change for a zero delta', () => {
  const { note } = trimClip(project(), { trackId: 'trk_1', itemId: 'itm_1', edge: 'end', deltaSec: 0 })
  equal(note, '', 'a zero drag is not an edit')
})

test('splitClip produces two halves that add up to the original', () => {
  const before = project()
  const { project: after, note } = splitClip(before, { trackId: 'trk_1', itemId: 'itm_1', atSec: 5, newItemId: 'itm_right' })
  const items = after.tracks[0].items
  assert.equal(items.length, 2, 'one clip becomes two')
  const left = items.find((entry) => entry.id === 'itm_1')
  const right = items.find((entry) => entry.id === 'itm_right')
  close(itemEnd(left), 5, 'the left half ends at the split point')
  close(right.startSec, 5, 'the right half starts there')
  close(right.inSec, 2, 'the right half reads from the split point in the material')
  close(itemLength(left) + itemLength(right), 2, 'the two halves cover the original length')
  check(/分割片段/.test(note), 'the note names the split')
})

test('splitClip keeps the id on the left half so references stay valid', () => {
  const { project: after } = splitClip(project(), { trackId: 'trk_1', itemId: 'itm_1', atSec: 5, newItemId: 'itm_right' })
  check(after.tracks[0].items.some((entry) => entry.id === 'itm_1'), 'the left half kept the id')
})

test('splitClip hands the fade-out to the right half and the fade-in to the left', () => {
  const before = project([item({ fadeInSec: 0.5, fadeOutSec: 0.8 })])
  const { project: after } = splitClip(before, { trackId: 'trk_1', itemId: 'itm_1', atSec: 5, newItemId: 'itm_right' })
  const left = after.tracks[0].items.find((entry) => entry.id === 'itm_1')
  const right = after.tracks[0].items.find((entry) => entry.id === 'itm_right')
  close(left.fadeInSec, 0.5, 'the left half keeps the fade-in')
  close(left.fadeOutSec, 0, 'and drops the fade-out')
  close(right.fadeInSec, 0, 'the right half has no fade-in')
  close(right.fadeOutSec, 0.8, 'and keeps the fade-out')
})

test('splitClip at an edge is a no-op', () => {
  equal(splitClip(project(), { trackId: 'trk_1', itemId: 'itm_1', atSec: 4, newItemId: 'x' }).note, '', 'at the start')
  equal(splitClip(project(), { trackId: 'trk_1', itemId: 'itm_1', atSec: 6, newItemId: 'x' }).note, '', 'at the end')
  equal(splitClip(project(), { trackId: 'trk_1', itemId: 'itm_1', atSec: 99, newItemId: 'x' }).note, '', 'past the end')
})

test('deleteClip removes only that clip and leaves the material', () => {
  const before = project([item({ id: 'a' }), item({ id: 'b', startSec: 8 })])
  const { project: after, note } = deleteClip(before, { trackId: 'trk_1', itemId: 'a' })
  equal(after.tracks[0].items.map((entry) => entry.id), ['b'], 'only a is gone')
  check(/删除片段/.test(note), 'the note names the deletion')
})

test('duplicateClip lands the copy right after the original', () => {
  const { project: after, note } = duplicateClip(project(), { trackId: 'trk_1', itemId: 'itm_1', newItemId: 'itm_copy' })
  const copy = after.tracks[0].items.find((entry) => entry.id === 'itm_copy')
  close(copy.startSec, 6, 'the copy starts where the original ends')
  close(itemLength(copy), 2, 'and is the same length')
  check(/复制片段/.test(note), 'the note names the copy')
})

test('setClipGain writes the value and rejects out-of-range input', () => {
  const { project: after, note } = setClipGain(project(), { trackId: 'trk_1', itemId: 'itm_1', gainDb: -3.5 })
  close(after.tracks[0].items[0].gainDb, -3.5, 'gain applied')
  check(/增益/.test(note), 'the note names the gain')
  assert.throws(() => setClipGain(project(), { trackId: 'trk_1', itemId: 'itm_1', gainDb: 40 }), EditError, 'over +24 dB')
  assert.throws(() => setClipGain(project(), { trackId: 'trk_1', itemId: 'itm_1', gainDb: -200 }), EditError, 'under -120 dB')
})

test('setClipPan writes the value and rejects out-of-range input', () => {
  const { project: after } = setClipPan(project(), { trackId: 'trk_1', itemId: 'itm_1', pan: -0.75 })
  close(after.tracks[0].items[0].pan, -0.75, 'pan applied')
  assert.throws(() => setClipPan(project(), { trackId: 'trk_1', itemId: 'itm_1', pan: 2 }), EditError)
})

test('setClipFades clamps so the two fades cannot overlap', () => {
  const { project: after } = setClipFades(project(), { trackId: 'trk_1', itemId: 'itm_1', fadeInSec: 1.5, fadeOutSec: 1.5 })
  const clip = after.tracks[0].items[0]
  close(clip.fadeInSec, 1.5, 'the fade-in fits')
  close(clip.fadeOutSec, 0.5, 'the fade-out is cut to what is left of the 2s clip')
  check(clip.fadeInSec + clip.fadeOutSec <= itemLength(clip) + 1e-9, 'they never overlap')
})

test('setClipFades leaves the other fade alone when only one is given', () => {
  const before = project([item({ fadeInSec: 0.3, fadeOutSec: 0.4 })])
  const { project: after } = setClipFades(before, { trackId: 'trk_1', itemId: 'itm_1', fadeInSec: 0.9 })
  close(after.tracks[0].items[0].fadeInSec, 0.9, 'the given fade moved')
  close(after.tracks[0].items[0].fadeOutSec, 0.4, 'the other stayed')
})

test('setClipFades rejects a negative fade by clamping to zero', () => {
  const { project: after } = setClipFades(project(), { trackId: 'trk_1', itemId: 'itm_1', fadeInSec: -3 })
  close(after.tracks[0].items[0].fadeInSec, 0, 'negative collapses to zero')
})

test('setClipMuted toggles and reports no note when unchanged', () => {
  const { project: after, note } = setClipMuted(project(), { trackId: 'trk_1', itemId: 'itm_1', muted: true })
  equal(after.tracks[0].items[0].muted, true, 'muted')
  check(/静音/.test(note), 'the note names the mute')
  equal(setClipMuted(after, { trackId: 'trk_1', itemId: 'itm_1', muted: true }).note, '', 'muting twice records nothing')
})

test('every operation throws on an unknown track or clip', () => {
  assert.throws(() => moveClip(project(), { trackId: 'nope', itemId: 'itm_1', startSec: 1 }), EditError)
  assert.throws(() => moveClip(project(), { trackId: 'trk_1', itemId: 'nope', startSec: 1 }), EditError)
  assert.throws(() => deleteClip(project(), { trackId: 'trk_1', itemId: 'nope' }), EditError)
})

test('assertWithinLimits rejects a project longer than 15 minutes', () => {
  const long = project([item({ startSec: 0, inSec: 0, outSec: 901 })])
  assert.throws(() => assertWithinLimits(long), EditError, 'over 15 minutes')
  const fine = project([item({ startSec: 0, inSec: 0, outSec: 900 })])
  check(assertWithinLimits(fine), 'exactly 15 minutes is allowed')
})

test('assertWithinLimits counts a longer video as the project length', () => {
  const withVideo = project([item({ startSec: 0, inSec: 0, outSec: 10 })])
  withVideo.video = { path: 'video/clip.mp4', durationSec: 1200, locked: true }
  assert.throws(() => assertWithinLimits(withVideo), EditError, 'the picture can push past the limit too')
})

test('assertWithinLimits rejects more than 20 tracks', () => {
  const many = project()
  for (let i = 0; i < 20; i++) many.tracks.push({ ...many.tracks[0], id: `trk_${i}`, items: [] })
  assert.throws(() => assertWithinLimits(many), EditError, '21 tracks is over the limit')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
