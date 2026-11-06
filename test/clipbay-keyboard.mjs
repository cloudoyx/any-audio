/**
 * Keyboard behaviour of the timeline (improvement plan 01, I-07 and I-08).
 *
 * Two regressions:
 *  - Space started playback only when the focus happened to be on nothing. After
 *    clicking 静音 the button kept focus, and the browser re-fired that button on
 *    Space, so the transport key silently toggled mute instead.
 *  - Once a clip was selected there was no way to deselect it: only deleting the
 *    clip cleared the selection.
 *
 * The handlers live inside a React component, so the checks read the source. The
 * behaviour itself was verified in the browser; these tests keep the two rules
 * from being quietly dropped again.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const file = join(root, 'src', 'client', 'clipbay', 'timeline.js')
const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

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

/** The body of the Space handler, so a check cannot accidentally match elsewhere. */
function spaceHandler() {
  const start = source.indexOf("if (event.code === 'Space')")
  assert.ok(start > 0, 'the Space handler must exist')
  return source.slice(start, start + 600)
}

test('Space is never taken away from the transport by a focused button', () => {
  // The first attempt put BUTTON in the opt-out list, and the result was the
  // worst of both: the transport not toggling *and* the browser activating the
  // button (a click on 静音 muted a track instead of starting playback).
  const guard = source.slice(source.indexOf('const tag = target?.tagName'), source.indexOf("if (event.code === 'Space')"))
  assert.equal(/tag === 'BUTTON'/.test(guard), false, 'a button must not opt out of Space')
  assert.equal(/tag === 'A'/.test(guard), false, 'nor a link')
})

test('Space blurs the focused control before toggling the transport', () => {
  const body = spaceHandler()
  assert.match(body, /blur/, 'the focused control is blurred so its click never fires')
  assert.match(body, /preventDefault/, 'and the default activation is suppressed')
  assert.match(body, /transport\?\.playing/, 'Space toggles playback')
})

test('inputs, textareas, selects and contenteditable still opt out', () => {
  const guard = source.slice(source.indexOf('const tag = target?.tagName'), source.indexOf("if (event.code === 'Space')"))
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.match(guard, new RegExp(`tag === '${tag}'`), `${tag} must opt out`)
  }
  assert.match(guard, /isContentEditable/, 'contenteditable must opt out')
})

test('Escape clears the selection', () => {
  // The file has two Escape handlers: one closes the track-rename input, one
  // clears the selection. Only the second one is a bare `if (...) {` on its own
  // line, so match that shape.
  const match = source.match(/\n\s*if \(event\.key === 'Escape'\) \{\n/)
  assert.ok(match, 'the keyboard Escape branch must exist')
  const body = source.slice(match.index, match.index + 700)
  assert.match(body, /onClearSelection\?\.\(\)/, 'Escape calls the clear handler')
  assert.match(body, /preventDefault/, 'and consumes the key')
})

test('Escape is handled before the selection guard', () => {
  // Order matters: the delete/duplicate branches bail out when nothing is
  // selected, and Escape must still work in exactly that situation.
  const escapeAt = source.indexOf('onClearSelection?.()')
  const guardAt = source.indexOf('if (!selection?.itemId) return')
  assert.ok(escapeAt > 0 && guardAt > 0, 'both branches exist')
  assert.ok(escapeAt < guardAt, 'Escape must not sit behind the "something is selected" guard')
})

test('the clear handler drops the range as well as the selection', () => {
  const panel = readFileSync(join(root, 'src', 'client', 'clipbay', 'panel.js'), 'utf8').replace(/\r\n/g, '\n')
  const start = panel.indexOf('const clearSelection = useCallback')
  assert.ok(start > 0, 'the panel defines clearSelection')
  const body = panel.slice(start, start + 300)
  assert.match(body, /setSelection\(null\)/, 'the clip selection is cleared')
  assert.match(body, /setRange\(null\)/, 'the dragged range is cleared too')
  assert.match(panel, /onClearSelection: clearSelection/, 'the timeline is wired to it')
})

test('the timeline accepts the clear prop', () => {
  assert.match(source, /onClearSelection/, 'Timeline takes onClearSelection')
  const signature = source.slice(source.indexOf('export function Timeline('), source.indexOf('export function Timeline(') + 200)
  assert.match(signature, /onClearSelection/, 'and it is in the destructured props')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
