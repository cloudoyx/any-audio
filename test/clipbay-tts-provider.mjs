/**
 * Per-item TTS provider resolution (improvement plan 01, I-03).
 *
 * The regression this covers: `anyaudio_tts` read the top-level `provider`
 * before it read `items[].provider`, so a configured MiMo default rejected an
 * all-edge batch with "MiMo TTS needs an API key". The schema has always
 * advertised a per-item provider, so it has to win.
 *
 * `resolveProviders` is exported for exactly this test; the network is never
 * touched (synthesis is not part of this path).
 */
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
process.env.ANYAUDIO_CONFIG = `${root}/.anyaudio/test-tmp-tts/config.json`
process.env.ANYAUDIO_STATE = `${root}/.anyaudio/test-tmp-tts/state.json`
process.env.ANYAUDIO_FONT_DIR = `${root}/.anyaudio/test-tmp-tts/fonts`

const { resolveProviders } = await import(new URL('../src/tools/tts.js', import.meta.url).href)

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

test('the top-level provider fills in an item that names none', () => {
  const { items } = resolveProviders([{ text: 'a' }, { text: 'b' }], 'mimo')
  assert.deepEqual(items.map((item) => item.provider), ['mimo', 'mimo'])
})

test('a per-item provider wins over the top-level default', () => {
  // This is the exact call that used to throw.
  const { items, needsMimoKey } = resolveProviders(
    [{ text: 'a', provider: 'edge' }, { text: 'b', provider: 'edge' }],
    'mimo',
  )
  assert.deepEqual(items.map((item) => item.provider), ['edge', 'edge'])
  assert.equal(needsMimoKey, false, 'an all-edge batch must not ask for a MiMo key')
})

test('a mixed batch needs a MiMo key, and keeps both engines', () => {
  const { items, needsMimoKey } = resolveProviders(
    [{ text: 'a', provider: 'edge' }, { text: 'b', provider: 'mimo' }],
    'edge',
  )
  assert.deepEqual(items.map((item) => item.provider), ['edge', 'mimo'])
  assert.equal(needsMimoKey, true)
})

test('an item with no text never forces a MiMo key', () => {
  // A skipped item must not be able to sink the batch: nothing will be
  // synthesised for it, so no key is needed on its behalf.
  const { needsMimoKey } = resolveProviders([{ text: '', provider: 'mimo' }, { text: 'a', provider: 'edge' }], 'edge')
  assert.equal(needsMimoKey, false)
})

test('an unknown per-item provider is refused by name', () => {
  assert.throws(
    () => resolveProviders([{ text: 'a', provider: 'nope' }], 'edge'),
    /unknown TTS provider "nope"/,
  )
})

test('the top-level provider is still validated when an item overrides it', () => {
  // The top-level value goes through the same check up front in `execute`, and
  // `resolveProviders` validates whatever each item ends up with.
  assert.throws(
    () => resolveProviders([{ text: 'a' }], 'nope'),
    /unknown TTS provider "nope"/,
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
