/**
 * Front-end project state (plan M5.1).
 *
 * Pure functions only, so it can run in Node: the browser imports them, and the
 * test suite checks the round trip without a DOM.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'serialize.js'), 'utf8')

// The module has no imports and no JSX, so it evaluates as-is.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`
const { serializeProject, itemLengthSec, contentEndSec } = await import(moduleUrl)

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

const iso = '2026-11-06T09:00:00Z'

function sampleProject() {
  return {
    schemaVersion: 1,
    id: 'prj_state_test',
    name: 'state test',
    sampleRate: 48000,
    durationSec: 12,
    normalizeGainDb: -2.5,
    masterFaderDb: 0,
    createdAt: iso,
    modifiedAt: iso,
    history: [{ at: iso, by: 'agent', note: 'created' }],
    video: null,
    tracks: [
      {
        id: 'trk_a',
        name: 'Rain',
        category: 'ambience',
        muted: false,
        solo: false,
        items: [
          {
            id: 'itm_a1',
            material: 'mat_rain',
            startSec: 0,
            inSec: 0,
            outSec: 12,
            gainDb: 0,
            pan: 0,
            fadeInSec: 0.5,
            fadeOutSec: 0.5,
            muted: false,
            label: 'rain',
          },
        ],
      },
    ],
  }
}

test('serializeProject keeps every arrangement field', () => {
  const project = sampleProject()
  equal(serializeProject(project), project, 'a clean project must survive a round trip unchanged')
})

test('serializeProject drops view state that never belongs in the file', () => {
  const project = sampleProject()
  const dirty = structuredClone(project)
  dirty.playheadSec = 4.2
  dirty.selection = { trackId: 'trk_a', itemId: 'itm_a1' }
  dirty.zoom = 120
  dirty.undoStack = [{ kind: 'move' }]
  dirty.collapsed = ['trk_a']

  const out = serializeProject(dirty)
  equal(out, project, 'view state must not reach the file')
  for (const key of ['playheadSec', 'selection', 'zoom', 'undoStack', 'collapsed']) {
    check(!(key in out), `${key} leaked into the serialized project`)
  }
})

test('serializeProject drops view state on tracks and items too', () => {
  const project = sampleProject()
  const dirty = structuredClone(project)
  dirty.tracks[0].height = 88
  dirty.tracks[0].selected = true
  dirty.tracks[0].items[0].dragging = true
  dirty.tracks[0].items[0].waveformCache = [1, 2, 3]

  const out = serializeProject(dirty)
  equal(out, project, 'nested view state must not reach the file')
  check(!('height' in out.tracks[0]), 'track.height leaked')
  check(!('selected' in out.tracks[0]), 'track.selected leaked')
  check(!('dragging' in out.tracks[0].items[0]), 'item.dragging leaked')
  check(!('waveformCache' in out.tracks[0].items[0]), 'item.waveformCache leaked')
})

test('serializeProject keeps a video reference and its locked flag', () => {
  const project = sampleProject()
  project.video = { path: 'video/clip.mp4', durationSec: 30, locked: true }
  const out = serializeProject(project)
  equal(out.video, { path: 'video/clip.mp4', durationSec: 30, locked: true })
})

test('serializeProject does not mutate its input', () => {
  const project = sampleProject()
  const before = JSON.stringify(project)
  serializeProject(project)
  equal(JSON.stringify(project), before, 'serialize must be read-only')
})

test('itemLengthSec comes from the source range, not from startSec', () => {
  equal(itemLengthSec({ startSec: 100, inSec: 2, outSec: 5 }), 3)
  equal(itemLengthSec({ startSec: 0, inSec: 0, outSec: 0.25 }), 0.25)
})

test('contentEndSec follows the last clip', () => {
  const project = sampleProject()
  equal(contentEndSec(project), 12)
  project.tracks[0].items.push({ ...project.tracks[0].items[0], id: 'itm_a2', startSec: 20, outSec: 3 })
  equal(contentEndSec(project), 23, 'a later clip must move the end')
})

test('contentEndSec lets a longer video win', () => {
  const project = sampleProject()
  project.video = { path: 'video/clip.mp4', durationSec: 40, locked: true }
  equal(contentEndSec(project), 40, 'the picture owns the length when it is longer')
})

test('contentEndSec ignores a stored durationSec that disagrees', () => {
  const project = sampleProject()
  project.durationSec = 999
  equal(contentEndSec(project), 12, 'durationSec is derived, never trusted')
})

test('contentEndSec treats a muted clip as still occupying time', () => {
  const project = sampleProject()
  project.tracks[0].items[0].muted = true
  equal(contentEndSec(project), 12, 'muting does not shorten the timeline')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
