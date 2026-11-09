/**
 * Workbench layout (improvement plan 01, I-04 and I-05).
 *
 * Two changes: the clip bay fills the width it is given instead of stopping at
 * 900px, and the panel freezes its top half (header, preview row, transport) so
 * only the tracks scroll. The user's target was "at least 3–4 complete tracks
 * visible after freezing"; measured in the browser it is 4 at 1366×768 and 8 at
 * 1920×1080.
 *
 * The layout is CSS, so these checks read the source and keep the mistakes that
 * were already made once from coming back:
 *  - a `calc(100vh - Npx)` allowance only held for a one-line composer,
 *  - subtracting only the conversation header lets the tracks slide under the
 *    message composer on a narrow window.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')

const ui = read('src/client/ui.js')
const panel = read('src/client/clipbay/panel.js')
const timeline = read('src/client/clipbay/timeline.js')

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

test('the settings page keeps its reading width', () => {
  // Stretching a form across a 21:9 screen makes it harder to read, so the
  // width fix must not touch the shared page style.
  const page = ui.slice(ui.indexOf('page: {'), ui.indexOf('page: {') + 200)
  assert.match(page, /maxWidth: 900/, 'the settings page stays 900px wide')
})

test('the clip bay gets its own full-width style', () => {
  const workbench = ui.slice(ui.indexOf('workbench: {'), ui.indexOf('workbench: {') + 260)
  assert.match(workbench, /width: '100%'/, 'the workbench fills its container')
  assert.equal(/maxWidth/.test(workbench), false, 'and carries no width cap')
  assert.match(workbench, /minWidth: 0/, 'a flex child needs minWidth 0 to shrink below content')
})

test('the clip bay no longer uses the capped page style', () => {
  assert.equal(/style: S\.page/.test(panel), false, 'every clip bay container uses S.workbench')
  assert.match(panel, /S\.workbench/, 'and the workbench style is used')
})

test('the panel opts into the host composer overlay', () => {
  // The composer is drawn over the view; a multi-line draft used to push the
  // workbench out of the viewport. The host already has the switch for this, so
  // the panel carries its attribute rather than fighting the layout with a
  // magic calc() number.
  assert.match(panel, /'data-conversation-composer-overlay': ''/, 'the panel carries the overlay attribute')
  const at = panel.indexOf("'data-conversation-composer-overlay'")
  const root = panel.slice(Math.max(0, at - 200), at + 400)
  assert.match(root, /height: '100%'/, 'and fills the view area the host then gives it')
  assert.match(root, /paddingBottom: composerInset/, 'while reserving the composer band itself')
})

test('the panel measures the composer instead of assuming a height', () => {
  // The target was a hard-coded 250px allowance (header + one-line composer).
  // It broke the moment the draft wrapped and the composer grew to 210px.
  assert.equal(/calc\(100vh - \d+px\)/.test(panel), false, 'the calc height is gone')
  assert.match(panel, /new ResizeObserver/, 'the composer height is observed, not guessed')
  assert.match(panel, /\[data-composer-seat\]/, 'the observer watches the composer seat')
})

test('the panel clips its overflow so the frozen parts really stay put', () => {
  const head = panel.slice(panel.indexOf("height: '100%'"))
  assert.match(head.slice(0, 200), /overflow: 'hidden'/, 'the panel hides overflow')
})

test('the preview row is capped so the tracks keep most of the height', () => {
  const start = panel.indexOf('maxHeight: \'38%\'')
  assert.ok(start > 0, 'the preview row has a height cap')
  const row = panel.slice(Math.max(0, start - 400), start + 20)
  assert.match(row, /flex: '0 0 auto'/, 'the row does not grow')
})

test('clip properties sit beside the preview, not below the timeline', () => {
  // The user was explicit: the item properties belong to the right of the video,
  // the way 剪映 lays them out, and the column has to be wide enough for an EQ row
  // (type / Hz / dB / Q / delete) — "右侧固定加宽一些，剩余的给左侧的视频窗口区".
  const previewAt = panel.indexOf('h(Preview')
  const columnAt = panel.indexOf("flex: fxEditor ? '0 0 420px' : '0 0 340px'")
  const timelineAt = panel.indexOf('h(Timeline')
  assert.ok(previewAt > 0 && columnAt > 0 && timelineAt > 0, 'all three render')
  assert.ok(columnAt > previewAt, 'the properties column comes after the preview in document order')
  assert.ok(columnAt < timelineAt, 'and before the timeline, so they share its row')
  // The column is a fixed width and the picture takes the rest. It also has to
  // yield on a squeezed panel (wide right sidebar), or the picture becomes a
  // thumbnail — hence the `maxWidth` valve rather than a hard width.
  const row = panel.slice(panel.indexOf('h(Preview') - 700, timelineAt)
  assert.match(row, /flex: '1 1 0'/, 'the picture takes the space the column does not')
  assert.match(row, /flex: fxEditor \? '0 0 420px' : '0 0 340px'/, 'the column is a fixed width, wider while a chain is open')
  assert.match(row, /maxWidth: '55%'/, 'and it yields instead of squeezing the picture to nothing')
  // The column holds one editor at a time: the clip's own fields, or a chain.
  // Both have to be inside the row, between the picture and the timeline.
  const body = panel.slice(columnAt, timelineAt)
  assert.match(body, /h\(ClipProperties/, 'the clip properties render inside the column')
  assert.match(body, /h\(FxEditor/, 'and so does the effect-chain editor it swaps to')
})

test('the timeline is the only scrolling area', () => {
  const scroller = timeline.slice(timeline.indexOf('overflow: \'auto\''), timeline.indexOf('overflow: \'auto\'') + 200)
  assert.match(scroller, /flex: 1/, 'the track area takes the leftover height')
  assert.match(scroller, /minHeight: 0/, 'and may shrink (flex children default to min-content)')
  // The old fixed cap fought the frozen layout; it must be gone.
  assert.equal(/maxHeight: '60vh'/.test(timeline), false, 'the 60vh cap is gone')
})

test('the ruler stays visible while the tracks scroll', () => {
  assert.match(timeline, /position: 'sticky'/, 'the ruler is sticky')
  assert.match(timeline, /top: 0/, 'pinned to the top of the scroller')
})

test('tracks are compact enough to fit several on screen', () => {
  const height = Number(timeline.match(/const TRACK_HEIGHT = (\d+)/)[1])
  assert.ok(height <= 52, `a track row must stay at or under 52px, got ${height}`)
  // 1366×768 leaves ~227px of track area; four rows has to fit in that.
  assert.ok(height * 4 <= 230, `four rows must fit in 230px, four rows take ${height * 4}px`)
})

test('every track row is the same height, selected or not', () => {
  // An "active" row used to be 16px taller. That fired on Alt-drag range
  // selection too, so selecting a 20–35s stretch silently made that one track
  // taller than its neighbours — it read as a rendering bug, not as emphasis.
  assert.equal(/TRACK_HEIGHT_ACTIVE/.test(timeline), false, 'there is no separate active height')
  const row = timeline.slice(timeline.indexOf('function TrackRow('), timeline.indexOf('function TrackRow(') + 400)
  assert.match(row, /const height = TRACK_HEIGHT\b/, 'the row uses the one track height')
})

test('the track head is never taller than the track it labels', () => {
  // The head stacked four rows of controls (name / M·S·段·✕ / volume / pan) and
  // grew to 81px, stretching every 52px row to 82px — 30px wasted per track.
  const head = timeline.slice(timeline.indexOf('function TrackHead('), timeline.indexOf('function TrackHead(') + 900)
  assert.match(head, /width: headWidth, height,/, 'the head takes its height from the row instead of its content')
  assert.equal(/flexDirection: 'column', gap: 4/.test(head), false, 'the controls are no longer four stacked rows')
})

test('the head width is adjustable, and the divider is the only place it drags', () => {
  // The user found an `↔` cursor between the head and the waveform and expected
  // it to resize the head. It was a clip's trim handle: a clip starting at 0s has
  // its left edge exactly against the head. So the width became adjustable, and
  // the grip lives on the ruler corner — above the tracks, where no clip edge can
  // be mistaken for it.
  assert.match(timeline, /const HEAD_MIN = \d+/, 'a floor, so a drag cannot erase the head')
  assert.match(timeline, /const HEAD_MAX = \d+/, 'a ceiling, so a drag cannot hide the timeline')
  assert.match(timeline, /cursor: 'col-resize'/, 'the divider says it can be dragged')
  assert.match(timeline, /onPointerDown: startHeadDrag/, 'and it is wired to the drag')
  const head = timeline.slice(timeline.indexOf('function TrackHead('), timeline.indexOf('function TrackHead(') + 900)
  assert.equal(/cursor: 'ew-resize'/.test(head), false, 'the head itself must not offer a resize cursor: that is what misled the person')
})

test('the head is narrow enough to leave the waveform its space', () => {
  const head = Number(timeline.match(/const HEAD_WIDTH = (\d+)/)[1])
  assert.ok(head <= 150, `the track head must stay at or under 150px, got ${head}`)
})

test('the track heads are frozen against horizontal scrolling', () => {
  // The heads name the track and carry its faders. Scrolled sideways they used
  // to travel with the audio (measured: left edge 289 → -511 at scrollLeft 800),
  // which leaves a wall of anonymous waveforms.
  const head = timeline.slice(timeline.indexOf('function TrackHead('), timeline.indexOf('function TrackHead(') + 2000)
  assert.match(head, /position: 'sticky'/, 'the head is sticky')
  assert.match(head, /left: 0/, 'pinned to the left edge of the scroller')
  assert.equal(/background: active \? C\.soft : 'transparent'/.test(head), false, 'a transparent head would let the clips show through it')
  // The ruler's leading corner must stay put on both axes at once.
  assert.match(timeline, /position: 'sticky', left: 0, zIndex: 3/, 'the ruler corner is frozen sideways too')
})

test('a track silenced by someone else\u2019s solo is drawn as unhearable', () => {
  // The mixer always honoured solo: `resolveTrackGain` returns 0 for every
  // non-soloed track. The timeline did not, so soloing one instrument left six
  // tracks looking perfectly healthy while they played nothing. Measured in the
  // browser before the fix: clicking S changed the solo button's own colour and
  // nothing else on screen.
  assert.match(timeline, /const anySolo = project\.tracks\.some\(\(track\) => track\.solo === true\)/, 'the timeline computes whether anything is soloed')
  assert.match(timeline, /audibleByTrack/, 'and maps each track to whether it can be heard')
  assert.match(timeline, /anySolo && track\.solo !== true/, 'the same rule the mixer uses: solo silences the other tracks')
  assert.match(timeline, /audible: audibleByTrack\.get\(track\.id\) !== false/, 'the row is told')
  const head = timeline.slice(timeline.indexOf('function TrackHead('), timeline.indexOf('function TrackHead(') + 2000)
  assert.match(head, /opacity: audible \? 1 : 0\.5/, 'the head dims rather than vanishing: it must stay clickable')
  const clip = timeline.slice(timeline.indexOf('function Clip('), timeline.indexOf('function Clip(') + 1600)
  assert.match(clip, /track\.muted \|\| item\.muted \|\| !audible/, 'the clip greys out too')
})

test('the playhead follows the head width the person dragged', () => {
  // Improvement plan 03, I-43. The head width became draggable in I-25 and every
  // row followed it except this one line, which kept the constant. Measured in
  // the browser: head at 341px, click at ruler x 200 → playhead at 637 instead of
  // 830, off by 193px ≈ 3.2 s, with nothing on screen to hint at it.
  assert.equal(/left: HEAD_WIDTH \+ playheadX/.test(timeline), false, 'the constant is gone from the playhead')
  assert.match(timeline, /left: headWidth \+ playheadX/, 'it uses the live width')
  // The constant is still the default the state starts from, so it must remain.
  assert.match(timeline, /useState\(HEAD_WIDTH\)/, 'the constant stays as the initial width')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
