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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
process.env.ANYAUDIO_CONFIG = `${root}/.anyaudio/test-tmp-tts/config.json`
process.env.ANYAUDIO_STATE = `${root}/.anyaudio/test-tmp-tts/state.json`
process.env.ANYAUDIO_FONT_DIR = `${root}/.anyaudio/test-tmp-tts/fonts`

const { resolveProviders, resolveItems } = await import(new URL('../src/tools/tts.js', import.meta.url).href)
const { providerForVoice, resolveVoice, MIMO_VOICES } = await import(new URL('../src/audio/tts-providers.js', import.meta.url).href)
const SCORING = readFileSync(join(root, 'src', 'skills', 'anyaudio-scoring.md'), 'utf8')

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

// --- voice names are per engine -------------------------------------------
//
// A voice name belongs to exactly one engine. Sending an Edge name to MiMo
// answers HTTP 400 "Param Incorrect", and the old error blamed the network for
// it. None of these tests touch the network.

test('a voice identifies the engine that owns it', () => {
  assert.equal(providerForVoice('zh-CN-XiaoxiaoNeural'), 'edge')
  assert.equal(providerForVoice('冰糖'), 'mimo')
})

test('a voice no engine claims is left alone', () => {
  // Cloned and custom voice ids are legitimate, so an unknown name must not be
  // refused here — whether it exists is the service's call, not ours.
  assert.equal(providerForVoice('my-cloned-voice-01'), null)
  assert.equal(providerForVoice(''), null)
})

test('an unnamed voice falls back to the engine default', () => {
  const result = resolveVoice({ provider: 'edge', voice: undefined, fallbackVoice: 'zh-CN-YunjianNeural' })
  assert.deepEqual(result, { provider: 'edge', voice: 'zh-CN-YunjianNeural', switched: false })
})

test('a voice beats a configured engine but never an explicitly named one', () => {
  // A configured default is only a default, so the voice — the more specific
  // signal — wins, and the switch is reported back.
  const switched = resolveVoice({ provider: 'mimo', voice: 'zh-CN-XiaoxiaoNeural', explicitProvider: false })
  assert.deepEqual(switched, { provider: 'edge', voice: 'zh-CN-XiaoxiaoNeural', switched: true })
  // An engine the caller named is a decision, so a mismatch is an error.
  assert.throws(
    () => resolveVoice({ provider: 'mimo', voice: 'zh-CN-XiaoxiaoNeural', explicitProvider: true }),
    /belongs to Edge TTS, not MiMo/,
  )
})

test('resolveProviders switches the engine and reports it', () => {
  const { items, switches, needsMimoKey } = resolveProviders(
    [{ text: 'a', voice: 'zh-CN-XiaoxiaoNeural', label: 'item #1' }],
    'mimo',
    { explicitFallback: false },
  )
  assert.deepEqual(items.map((item) => item.provider), ['edge'])
  assert.equal(switches.length, 1)
  assert.equal(switches[0].from, 'mimo')
  assert.equal(switches[0].to, 'edge')
  // The item is an Edge line now, so it must not demand a MiMo key.
  assert.equal(needsMimoKey, false)
})

test('resolveProviders refuses a voice that contradicts a named engine', () => {
  assert.throws(
    () => resolveProviders(
      [{ text: 'a', provider: 'mimo', voice: 'zh-CN-XiaoxiaoNeural', label: 'item #1' }],
      'mimo',
      { explicitFallback: true },
    ),
    /Voice "zh-CN-XiaoxiaoNeural" belongs to Edge TTS, not MiMo/,
  )
})

test('a mismatched voice does not drag unrelated items across engines', () => {
  const { items, switches } = resolveProviders(
    [{ text: 'a', provider: 'edge', label: 'item #1' }, { text: 'b', voice: 'zh-CN-YunxiNeural', label: 'item #2' }],
    'mimo',
    { explicitFallback: false },
  )
  assert.deepEqual(items.map((item) => item.provider), ['edge', 'edge'])
  assert.equal(switches.length, 1, 'only the item that named an Edge voice switches')
})

test('an unknown voice keeps the engine it was given', () => {
  const { items, switches } = resolveProviders(
    [{ text: 'a', voice: 'my-cloned-voice-01', label: 'item #1' }],
    'mimo',
    { explicitFallback: false },
  )
  assert.deepEqual(items.map((item) => item.provider), ['mimo'])
  assert.equal(switches.length, 0)
})

// --- top-level defaults reach every item ------------------------------------
//
// The bug this covers: `anyaudio_tts` advertised a top-level `voice`, and `items`
// batches ignored it outright — the field was read from the item only. A call
// asking for 晓晓 came back in the configured voice, and nothing in the reply
// mentioned that the request had been dropped. Every optional field a batch may
// override is now merged in one place, so this cannot drift again.

test('a top-level voice reaches every item in a batch', () => {
  const items = resolveItems({
    voice: 'zh-CN-XiaoxiaoNeural',
    items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
  })
  assert.deepEqual(items.map((item) => item.voice), ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoxiaoNeural'])
})

test('an item field wins over the top-level default', () => {
  const items = resolveItems({
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%',
    items: [{ text: 'a' }, { text: 'b', voice: 'zh-CN-YunxiNeural', rate: '-10%' }],
  })
  assert.equal(items[0].voice, 'zh-CN-XiaoxiaoNeural', 'the default applies')
  assert.equal(items[1].voice, 'zh-CN-YunxiNeural', 'the item overrides it')
  assert.equal(items[1].rate, '-10%')
  assert.equal(items[0].rate, '+0%')
})

test('every field a batch may override is carried down', () => {
  // One assertion per field: a new field that forgets the merge fails here
  // rather than silently doing nothing in production.
  const [item] = resolveItems({
    provider: 'edge', voice: 'v', rate: 'r', pitch: 'p', volume: 'vol',
    style: 's', proxy: 'http://x', trackName: 'n', startSec: 4,
    items: [{ text: 'a' }],
  })
  assert.deepEqual(
    { provider: item.provider, voice: item.voice, rate: item.rate, pitch: item.pitch, volume: item.volume, style: item.style, proxy: item.proxy, trackName: item.trackName, startSec: item.startSec },
    { provider: 'edge', voice: 'v', rate: 'r', pitch: 'p', volume: 'vol', style: 's', proxy: 'http://x', trackName: 'n', startSec: 4 },
  )
})

test('a single-shot call still produces one item with its own fields', () => {
  const items = resolveItems({ text: '  hello  ', voice: 'v' })
  assert.equal(items.length, 1)
  assert.equal(items[0].text, 'hello', 'the text is trimmed')
  assert.equal(items[0].voice, 'v')
  assert.equal(items[0].label, 'text')
})

test('an empty items array falls back to the single-shot shape', () => {
  const items = resolveItems({ text: 'hi', voice: 'v', items: [] })
  assert.equal(items.length, 1)
  assert.equal(items[0].text, 'hi')
})

test('items are labelled by position so a warning names the right line', () => {
  const items = resolveItems({ items: [{ text: 'a' }, { text: 'b' }] })
  assert.deepEqual(items.map((item) => item.label), ['item #1', 'item #2'])
})

test('the tool description names both engines\u2019 voices, including all of MiMo\u2019s', () => {
  // Improvement plan 03, I-46. The scoring skill listed only Edge voices while
  // the user's config said `tts.provider = "mimo"`; the Agent thought in Edge
  // names, sent provider:"edge" to override the person's setting, hit HTTP 429
  // twice and only found the MiMo voices by reading the config file by hand.
  for (const voice of MIMO_VOICES) {
    assert.ok(SCORING.includes(voice), `the scoring skill must name the MiMo voice ${voice}`)
  }
  assert.match(SCORING, /mimo_default/, 'including the cluster-resolved default')
})

test('nothing tells the Agent that Edge is the default', () => {
  // The parenthesised "(edge)" read as "the default is edge", which is exactly
  // the wrong summary of a config that says mimo.
  const tts = readFileSync(join(root, 'src', 'tools', 'tts.js'), 'utf8')
  const providerField = tts.slice(tts.indexOf('provider: { type: \'string\''), tts.indexOf('voice: { type: \'string\''))
  assert.doesNotMatch(providerField, /\(edge\)/, 'the provider description no longer suggests a default')
  assert.match(providerField, /the provider the user configured/, 'it points at the setting instead')

  const index = readFileSync(join(root, 'src', 'index.js'), 'utf8')
  assert.doesNotMatch(index, /\(Edge, or MiMo-V2\.5-TTS when selected\)/, 'the system prompt no longer puts Edge first')
  assert.match(index, /come from what the user configured in Settings → AnyAudio/, 'it names the setting only')
  // Passing them was described as a normal choice ("pass voice to choose another")
  // and the model did exactly that, overriding a configured MiMo engine with edge
  // (improvement plan 04). The rule now names the only legitimate reason.
  assert.match(index, /leave provider and voice out unless the person asked/, 'it says when overriding is allowed')
  assert.doesNotMatch(index, /tool arguments always override those defaults/, 'overriding is no longer the default behaviour')
})

test('a 429 sends the Agent to the other engine, not to the settings page', () => {
  // The old text said "switch the narration engine to MiMo in Settings -> AnyAudio",
  // which is a dead end mid-task: the Agent cannot open the settings page, and the
  // engine can be switched per call.
  const providers = readFileSync(join(root, 'src', 'audio', 'tts-providers.js'), 'utf8')
  const message = providers.split(/\r?\n/).find((line) => line.includes('Edge TTS is rate limiting'))
  assert.ok(message, 'the 429 branch is still there')
  assert.match(message, /provider:"mimo"/, 'it names the argument that switches engines')
  assert.doesNotMatch(message, /Settings -> AnyAudio/, 'and stops pointing at a page the Agent cannot open')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
