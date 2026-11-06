/**
 * The 添加到对话 mention (plan M6, spec §9.3 path B).
 *
 * The risky part is not the string format — it is that `setDraft` replaces the
 * whole draft, so a careless implementation deletes the sentence the person was
 * halfway through writing. `appendToDraft` exists to make that impossible, and
 * the host side is exercised in test/clipbay-project-tool.mjs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'src', 'client', 'clipbay', 'mention.js'), 'utf8')
const serialize = readFileSync(join(root, 'src', 'client', 'clipbay', 'serialize.js'), 'utf8')
const combined = `${serialize.replace(/^import .*$/gm, '')}\n${source.replace(/^import .*$/gm, '')}`
const { buildMention, appendToDraft, formatClock, clampRange, clipSpan } = await import(
  `data:text/javascript;base64,${Buffer.from(combined, 'utf8').toString('base64')}`
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

const project = {
  id: 'prj_ab12cd34',
  tracks: [
    {
      id: 'trk_01',
      name: '鼓组',
      items: [
        { id: 'itm_07', label: 'Bridge', startSec: 72, inSec: 0, outSec: 14 },
        { id: 'itm_08', label: '', startSec: 90, inSec: 1, outSec: 3 },
      ],
    },
    { id: 'trk_02', name: '旁白', items: [] },
  ],
}

test('a clip names itself and carries the project id', () => {
  const mention = buildMention(project, { trackId: 'trk_01', itemId: 'itm_07' })
  check(mention.text === '@[Bridge](anyaudio://timeline/prj_ab12cd34/itm_07)', mention.text)
  check(mention.target === 'itm_07', 'the clip id is the target')
})

test('a clip without a label falls back to the track name', () => {
  const mention = buildMention(project, { trackId: 'trk_01', itemId: 'itm_08' })
  check(mention.label === '鼓组', `got "${mention.label}"`)
})

test('a bare track carries no range', () => {
  const mention = buildMention(project, { trackId: 'trk_02' })
  check(mention.text === '@[旁白](anyaudio://timeline/prj_ab12cd34/trk_02)', mention.text)
  check(mention.fromSec === null && mention.toSec === null, 'no range')
})

test('a track with a range writes both ends into the uri', () => {
  const mention = buildMention(project, { trackId: 'trk_01', fromSec: 72, toSec: 86 })
  check(mention.text === '@[鼓组 1:12–1:26](anyaudio://timeline/prj_ab12cd34/trk_01@72.0-86.0)', mention.text)
})

test('an empty or inverted range is ignored', () => {
  const empty = buildMention(project, { trackId: 'trk_01', fromSec: 10, toSec: 10 })
  // A bare `@[label](uri)` is correct here: the range is simply absent, not a
  // stray `@` in the URI.
  check(empty.text === '@[鼓组](anyaudio://timeline/prj_ab12cd34/trk_01)', empty.text)
  const inverted = buildMention(project, { trackId: 'trk_01', fromSec: 20, toSec: 5 })
  check(inverted.text === '@[鼓组](anyaudio://timeline/prj_ab12cd34/trk_01)', inverted.text)
})

test('an unknown track or clip yields null instead of a dangling mention', () => {
  check(buildMention(project, { trackId: 'trk_nope' }) === null, 'unknown track')
  check(buildMention(project, { trackId: 'trk_01', itemId: 'itm_nope' }) === null, 'unknown clip')
  check(buildMention({ tracks: [] }, { trackId: 'trk_01' }) === null, 'no project id')
})

test('formatClock drops the hour below an hour and the tenths when zero', () => {
  check(formatClock(72) === '1:12', formatClock(72))
  check(formatClock(86.5) === '1:26.5', formatClock(86.5))
  check(formatClock(3661) === '01:01:01', formatClock(3661))
  check(formatClock(0) === '0:00', formatClock(0))
})

test('appending to an empty draft is just the mention', () => {
  check(appendToDraft('', '@[鼓](x)') === '@[鼓](x)', 'empty draft')
  check(appendToDraft(undefined, '@[鼓](x)') === '@[鼓](x)', 'missing draft')
})

test('appending keeps what the person already typed', () => {
  const result = appendToDraft('这段不够激昂', '@[鼓组](anyaudio://timeline/p/trk_01)')
  check(result === '这段不够激昂\n@[鼓组](anyaudio://timeline/p/trk_01)', JSON.stringify(result))
})

test('appending trims trailing whitespace instead of stacking blank lines', () => {
  const result = appendToDraft('hello   \n\n', '@[x](y)')
  check(result === 'hello\n@[x](y)', JSON.stringify(result))
})

test('appending nothing to a draft changes nothing', () => {
  check(appendToDraft('keep me', '') === 'keep me', 'empty mention')
})

test('clampRange keeps a dragged range inside the content and orders the ends', () => {
  const forward = clampRange(3, 8, 12)
  check(forward.fromSec === 3 && forward.toSec === 8, JSON.stringify(forward))
  const backward = clampRange(9, 4, 12)
  check(backward.fromSec === 4 && backward.toSec === 9, JSON.stringify(backward))
  const beyond = clampRange(-2, 40, 12)
  check(beyond.fromSec === 0 && beyond.toSec === 12, JSON.stringify(beyond))
})

test('clipSpan adds the source length to the start', () => {
  const span = clipSpan({ startSec: 4, inSec: 1, outSec: 3 })
  check(span.startSec === 4 && span.endSec === 6, JSON.stringify(span))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
