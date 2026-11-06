/**
 * Saving (plan M5.7, spec §8.4).
 *
 * The debounce and the flush-on-unmount are the two behaviours the spec calls
 * out, and the URL shape is here because getting it wrong is a silent 400 rather
 * than a visible failure — the first version put root/id in the body and every
 * save was rejected while the UI still showed the edit.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'saving.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/export async function saveProject[\s\S]*$/m, '')
const { saveUrl, SAVE_DEBOUNCE_MS } = await import(
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

test('the debounce sits in the 200-300 ms window the spec names', () => {
  check(SAVE_DEBOUNCE_MS >= 200 && SAVE_DEBOUNCE_MS <= 300, `debounce is ${SAVE_DEBOUNCE_MS} ms`)
})

test('the save URL carries root and id in the query string', () => {
  const url = saveUrl('D:\\AniAudio', 'prj_demo')
  check(url.startsWith('/clipbay/project?'), `unexpected path: ${url}`)
  check(url.includes('root=D%3A%5CAniAudio'), `root not encoded as a query value: ${url}`)
  check(url.includes('id=prj_demo'), `id missing: ${url}`)
})

test('the save URL encodes values a path would break on', () => {
  const url = saveUrl('C:\\Users\\a b', 'prj_1')
  check(url.includes('root=C%3A%5CUsers%5Ca%20b'), `spaces or backslashes leaked: ${url}`)
})

test('the source sends the project in the body and never invents a history note', () => {
  const full = readFileSync(join(root, 'src', 'client', 'clipbay', 'saving.js'), 'utf8')
  check(/body: \{ project: serializeProject\(project\) \}/.test(full), 'the body must carry the project under `project`')
  check(!/note/.test(full.split('export async function saveProject')[1]?.split('}')[0] ?? ''), 'saveProject must not pass a note')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
