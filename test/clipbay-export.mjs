// Export and preview helpers (spec §10, §11).
//
// Only the pure parts are imported: the React hooks need a real renderer, and a
// hook that starts a job is exercised against the real routes in
// test/clipbay-media.mjs. What is checked here is what a person sees — the file
// name, which formats the project allows, and the progress sentence — plus the
// media URL the <video> element is pointed at.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/**
 * Run a browser module in Node. The imports are stripped and everything from
 * `stopAt` onward is dropped, so the React hooks and their `react` import never
 * load — the same trick test/clipbay-playback.mjs uses. `prelude` supplies the
 * few values those stripped imports would have provided.
 */
async function loadPure(file, stopAt, prelude = '') {
  const source = await readFile(join(root, 'src/client/clipbay', file), 'utf8')
  const cut = stopAt ? source.indexOf(stopAt) : -1
  const body = (cut >= 0 ? source.slice(0, cut) : source)
    .split('\n')
    .filter((line) => !/^import\s/.test(line))
    .join('\n')
  const full = `${prelude}\n${body}`
  return import(`data:text/javascript;base64,${Buffer.from(full, 'utf8').toString('base64')}`)
}

let passed = 0
let failed = 0
async function test(name, run) {
  try {
    await run()
    passed++
    console.log('ok  ', name)
  } catch (error) {
    failed++
    console.log('FAIL', name)
    console.log('     ', error.message)
  }
}

// The stripped imports have to come back as something. `t` returns its key so the
// assertions can look for either language; the rest only matter inside function
// bodies that these tests never call.
const PRELUDE = `
const API = '/api/dsh-any-audio'
const t = (key, ...args) => String(key).replace(/\\{(\\d+)\\}/g, (_, i) => args[Number(i)] ?? '')
const h = () => null
const C = { muted: '#888', border: '#333' }
const S = { notice: () => ({}) }
const useEffect = () => {}
const useRef = () => ({ current: null })
const useState = (value) => [value, () => {}]
`

const exporter = await loadPure('exporter.js', 'export function useExport', PRELUDE)

await test('a project without a picture offers wav and mp3', async () => {
  assertEqual(exporter.availableFormats({ video: null }).join(','), 'wav,mp3', 'audio-only formats')
  assertEqual(exporter.availableFormats({}).join(','), 'wav,mp3', 'a project with no video key at all')
})

await test('a project with a picture offers mp4 first', async () => {
  // MP4 is the whole point of importing a picture; offering WAV first would bury it.
  assertEqual(exporter.availableFormats({ video: { path: 'video/a.mp4' } }).join(','), 'mp4,wav,mp3', 'video formats')
})

await test('the export file name comes from the project name', async () => {
  assertEqual(exporter.exportName({ name: '雷雨短片' }, 'mp4'), '雷雨短片.mp4', 'a Chinese name survives')
  assertEqual(exporter.exportName({ name: 'My Film' }, 'wav'), 'My-Film.wav', 'spaces become dashes')
})

await test('a file name cannot escape the output folder', async () => {
  // The host keeps only the basename, but the client must not send "..\\x" either:
  // a name that reads like a path is a bug the person would see as a mystery file.
  assertEqual(exporter.exportName({ name: '../etc/passwd' }, 'wav'), '..-etc-passwd.wav', 'slashes are replaced')
  assertEqual(exporter.exportName({ name: 'a:b*c?d' }, 'wav'), 'a-b-c-d.wav', 'every reserved character goes')
})

await test('an unnamed project still gets a usable file name', async () => {
  assertEqual(exporter.exportName({}, 'wav'), 'mix.wav', 'fallback name')
  assertEqual(exporter.exportName({ name: '   ' }, 'mp3'), 'mix.mp3', 'whitespace-only name')
})

await test('a very long name is trimmed', async () => {
  const long = 'x'.repeat(200)
  const name = exporter.exportName({ name: long }, 'wav')
  assert(name.length <= 65, `name should be trimmed, got ${name.length} characters`)
})

await test('progress sentences name the phase and the track', async () => {
  assertEqual(exporter.describeJob(null), '', 'no job means no line')
  assert(/渲染/.test(exporter.describeJob({ status: 'running', phase: 'render', track: 2, tracks: 5 })), 'track progress')
  assert(/2/.test(exporter.describeJob({ status: 'running', phase: 'render', track: 2, tracks: 5 })), 'the track number appears')
  assert(/编码/.test(exporter.describeJob({ status: 'running', phase: 'encode', message: 'encoding mp3' })), 'encode phase')
  assert(/mp3/.test(exporter.describeJob({ status: 'running', phase: 'encode', message: 'encoding mp3' })), 'the format appears')
  assert(/已取消/.test(exporter.describeJob({ status: 'cancelled' })), 'cancelled')
  const failure = exporter.describeJob({ status: 'error', error: 'ffmpeg said no' })
  assert(/ffmpeg said no/.test(failure), `the failure reason must survive: ${failure}`)
  const done = exporter.describeJob({ status: 'done', file: 'D:/x/out.wav' })
  assert(/out\.wav/.test(done), `the finished file must be named: ${done}`)
})

const preview = await loadPure('preview.js', 'export function Preview', PRELUDE)
await test('the video is fetched from the clip bay video route', async () => {
  const url = preview.previewUrl('D:\\AniAudio', 'prj_x')
  assert(/\/clipbay\/video\?/.test(url), `unexpected url ${url}`)
  assert(/root=D%3A%5CAniAudio/.test(url), `the root must be encoded: ${url}`)
  assert(/project=prj_x/.test(url), `the project id must be there: ${url}`)
  // The media routes skip the client header, so the URL must not depend on one.
  assert(!/x-any-audio-client/i.test(url), 'the preview url must not carry the header')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
