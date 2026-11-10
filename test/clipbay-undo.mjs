/**
 * Undo / redo semantics (plan M5.6, spec §8.3).
 *
 * The two rules worth locking down in a test:
 *   - an Agent change does not enter the stack (it resets it instead);
 *   - the stack does not survive the panel, which is checked here by building a
 *     fresh one rather than persisting anything.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'undo.js'), 'utf8')
const mod = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
const { createHistory, pushHistory, canUndo, canRedo, undo, redo, resetHistory } = mod

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

const state = (value) => ({ arrangement: value })

test('a new history can neither undo nor redo', () => {
  const history = createHistory()
  check(!canUndo(history), 'no undo available')
  check(!canRedo(history), 'no redo available')
})

test('one edit makes exactly one undo step', () => {
  const before = state('one clip at 4s')
  const after = state('one clip at 9s')
  const history = pushHistory(createHistory(), before)
  check(canUndo(history), 'undo is available')
  check(!canRedo(history), 'redo is not')
  const step = undo(history, after)
  equal(step.project, before, 'undo returns the state before the edit')
  check(canRedo(step.history), 'redo becomes available')
})

test('redo walks back along the undone trail', () => {
  const a = state('a')
  const b = state('b')
  const c = state('c')
  let history = createHistory()
  history = pushHistory(history, a)
  history = pushHistory(history, b)

  const first = undo(history, c)
  equal(first.project, b, 'the first undo steps to b')
  const second = undo(first.history, first.project)
  equal(second.project, a, 'the second undo steps to a')

  const forward = redo(second.history, second.project)
  equal(forward.project, b, 'redo returns b')
  const last = redo(forward.history, forward.project)
  equal(last.project, c, 'and then c')
})

test('a new edit after an undo throws away the redo trail', () => {
  const a = state('a')
  const b = state('b')
  const c = state('c')
  let history = createHistory()
  history = pushHistory(history, a)
  history = pushHistory(history, b)
  const undone = undo(history, c)
  check(canRedo(undone.history), 'there was something to redo')

  const edited = pushHistory(undone.history, undone.project)
  check(!canRedo(edited), 'editing again drops the trail')
  equal(edited.past.length, 2, 'the earlier step survives')
})

test('undo at the bottom of the stack changes nothing', () => {
  const current = state('a')
  const step = undo(createHistory(), current)
  equal(step.project, current, 'the project is unchanged')
  equal(step.history.past.length, 0, 'and the stack is still empty')
})

test('redo at the top of the stack changes nothing', () => {
  const current = state('a')
  const step = redo(createHistory(), current)
  equal(step.project, current, 'the project is unchanged')
})

test('the stack is bounded, dropping the oldest steps', () => {
  let history = createHistory()
  for (let i = 0; i < 130; i++) history = pushHistory(history, state(`s${i}`), 100)
  equal(history.past.length, 100, 'only the last 100 survive')
  equal(history.past[99], state('s129'), 'the newest step is kept')
  equal(history.past[0], state('s30'), 'the oldest kept step is s30')
})

test('an Agent change resets the stack instead of entering it', () => {
  let history = createHistory()
  history = pushHistory(history, state('user edit'))
  check(canUndo(history), 'the user edit is undoable')

  // The Agent rewrote the project on disk; the panel reloads it.
  const reset = resetHistory()
  check(!canUndo(reset), 'the Agent change is not undoable')
  check(!canRedo(reset), 'and nothing else is either')
})

test('a fresh panel starts with an empty stack', () => {
  let history = createHistory()
  history = pushHistory(history, state('before'))
  history = pushHistory(history, state('also before'))
  check(canUndo(history), 'the old panel had steps')

  // Switching to 对话 and back unmounts and remounts, so a new history object is
  // all that survives — which is nothing.
  const remounted = createHistory()
  check(!canUndo(remounted), 'the remounted panel cannot undo')
  check(!canRedo(remounted), 'nor redo')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
