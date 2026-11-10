/**
 * Which workspace the clip bay reads (improvement plan 01, I-01).
 *
 * The regression this covers: the panel used to fall back to the first entry of
 * the workspace registry whenever it could not match the Session — and it could
 * never match, because it read a `current` field the Session snapshot does not
 * have. Every Session therefore saw `D:\AniAudio`'s projects, including Sessions
 * belonging to another workspace.
 *
 * `workspaceForSession` is a pure function so the resolution is testable without
 * a DOM. The module is loaded the same way the other front-end tests load it:
 * the source is evaluated as a data URL, with the React import stripped.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const file = join(root, 'src', 'client', 'clipbay', 'panel.js')
const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

// Keep only the pure helper: everything below `formatDuration` needs React, and
// the helper itself has no imports.
const match = source.match(/export function workspaceForSession\([\s\S]*?\n}\n/)
if (!match) throw new Error('workspaceForSession is missing from panel.js')
const helper = match[0].replace('export function', 'function')
const moduleUrl = `data:text/javascript;base64,${Buffer.from(`${helper}\nexport { workspaceForSession }`, 'utf8').toString('base64')}`
const { workspaceForSession } = await import(moduleUrl)

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

const ANI = { workspaceId: 'ws_ani', path: 'D:\\AniAudio', title: 'AniAudio', sessionIds: ['session-a', 'session-b'] }
const DSH = { workspaceId: 'ws_dsh', path: 'C:\\Users\\Administrator\\.dsh', title: '.dsh', sessionIds: ['session-c'] }
const ITEMS = [ANI, DSH]

test('a Session of the first workspace resolves to it', () => {
  assert.deepEqual(workspaceForSession(ITEMS, 'session-a'), ANI)
})

test('a Session of the second workspace resolves to it, not to the first', () => {
  // The whole point of the fix: this used to return ANI.
  assert.deepEqual(workspaceForSession(ITEMS, 'session-c'), DSH)
})

test('an unmatched Session resolves to nothing', () => {
  // No `items[0]` fallback: guessing here would autosave into a folder the page
  // was never pointed at.
  assert.equal(workspaceForSession(ITEMS, 'session-unknown'), null)
})

test('a missing Session id resolves to nothing', () => {
  assert.equal(workspaceForSession(ITEMS, undefined), null)
  assert.equal(workspaceForSession(ITEMS, null), null)
  assert.equal(workspaceForSession(ITEMS, ''), null)
})

test('an empty registry resolves to nothing', () => {
  assert.equal(workspaceForSession([], 'session-a'), null)
  assert.equal(workspaceForSession(undefined, 'session-a'), null)
})

test('a workspace without a sessionIds array never matches', () => {
  const broken = [{ workspaceId: 'ws_x', path: 'D:\\X' }]
  assert.equal(workspaceForSession(broken, 'session-a'), null)
})

test('the registry order does not decide the answer', () => {
  // Same pair, reversed: each Session must still get its own workspace.
  assert.deepEqual(workspaceForSession([DSH, ANI], 'session-a'), ANI)
  assert.deepEqual(workspaceForSession([DSH, ANI], 'session-c'), DSH)
})

test('the new panel does not read the dead useSessions field', () => {
  // Guards the specific mistake: `useSessions(...).current` never exists, so any
  // code reading it silently degrades to a fallback that reads someone else's
  // projects.
  assert.equal(/\.current\b/.test(source), false, 'panel.js must not read a `current` session field')
  assert.equal(/items\[0\]/.test(source), false, 'panel.js must not fall back to the first workspace')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
