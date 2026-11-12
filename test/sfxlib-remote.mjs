// M6 acceptance: the online CC0 fallback.
//
// A local HTTP server stands in for freesound.org, so this test never touches
// the real site: the page structure it parses is the one captured from a real
// search, and the CDN is a file server.
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  downloadPreview,
  parseSearchPage,
  parseTotal,
  remoteCacheDir,
  remoteSource,
  searchFreesound,
} from '../src/audio/freesound.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const anyaudioDir = join(root, '.anyaudio')
const hadAnyaudioDir = existsSync(anyaudioDir)
const tmpDir = join(anyaudioDir, 'test-tmp-sfxlib-remote')
await rm(tmpDir, { recursive: true, force: true })
await mkdir(tmpDir, { recursive: true })

process.env.ANYAUDIO_SFX_REMOTE_DIR = join(tmpDir, 'sfx-remote')

let passed = 0
let failed = 0

async function test(name, run) {
  try {
    await run()
    passed++
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** One result block, shaped like the real page's markup. */
function resultBlock({ id, title, duration, author, downloads, rating, mp3 }) {
  return `
<div class="bw-search__result" data-score="8.14">
  <div class="bw-player"
    data-sound-id="${id}"
    data-username="${author}"
    data-mp3="${mp3}"
    data-title="${title}"
    data-duration="${duration}"
    data-num-downloads="${downloads}"
    aria-label="Average rating of ${rating}">
  </div>
</div>`
}

const PAGE = `<!doctype html><html><body>
<div class="col-4">683 sounds</div>
${resultBlock({ id: 865364, title: 'Knocking on Wooden Door 6', duration: 2.0, author: 'Valerie-Vivegnis', downloads: 239, rating: 3.5, mp3: 'https://cdn.example/previews/865/865364_15375955-lq.mp3' })}
${resultBlock({ id: 865365, title: 'Door knock heavy', duration: 1.4, author: 'someone', downloads: 12, rating: 4.5, mp3: 'https://cdn.example/previews/865/865365_1-lq.mp3' })}
</body></html>`

const EMPTY_PAGE = '<!doctype html><html><body><div>0 sounds</div></body></html>'

// A real MP3, so the placement path can actually convert it. Generated once with
// ffmpeg; the download tests only care that the bytes arrive intact.
const { findFfmpeg, runFfmpeg } = await import('../src/tools/shared.js')
const ffmpeg = findFfmpeg()
const previewFile = join(tmpDir, 'preview.mp3')
if (ffmpeg) {
  await runFfmpeg(ffmpeg.command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-ac', '2', '-ar', '48000', '-b:a', '128k', '-c:a', 'libmp3lame',
    previewFile,
  ])
}
const previewBytes = ffmpeg ? await readFile(previewFile) : Buffer.from('fake-mp3-bytes')

let requests = []
let server
let base

function startServer() {
  return new Promise((resolvePromise) => {
    server = http.createServer((req, res) => {
      requests.push(req.url)
      if (req.url.startsWith('/search/')) {
        const query = new URL(req.url, 'http://localhost').searchParams.get('q') ?? ''
        const body = query === 'nothing' ? EMPTY_PAGE : PAGE
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(body)
        return
      }
      if (req.url.startsWith('/previews/')) {
        if (req.url.includes('missing')) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg' })
        res.end(previewBytes)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      process.env.ANYAUDIO_FREESOUND_BASE = base
      resolvePromise()
    })
  })
}

await startServer()

// ---------------------------------------------------------------------------

await test('the parser reads every field from one result block', async () => {
  const results = parseSearchPage(PAGE)
  assert(results.length === 2, `expected 2 results, got ${results.length}`)
  const first = results[0]
  assert(first.soundId === 865364, `soundId was ${first.soundId}`)
  assert(first.title === 'Knocking on Wooden Door 6', `title was ${first.title}`)
  assert(first.durationSec === 2, `durationSec was ${first.durationSec}`)
  assert(first.author === 'Valerie-Vivegnis', `author was ${first.author}`)
  assert(first.downloads === 239, `downloads was ${first.downloads}`)
  assert(first.rating === 3.5, `rating was ${first.rating}`)
})

await test('the low-quality preview link becomes the high-quality one', async () => {
  const results = parseSearchPage(PAGE)
  assert(results[0].previewUrl.endsWith('-hq.mp3'), `previewUrl was ${results[0].previewUrl}`)
  assert(!results[0].previewUrl.includes('-lq.mp3'), 'the low-quality suffix should be gone')
})

await test('the page total is read when the page states it', async () => {
  assert(parseTotal(PAGE) === 683, `total was ${parseTotal(PAGE)}`)
  assert(parseTotal(EMPTY_PAGE) === 0, `empty total was ${parseTotal(EMPTY_PAGE)}`)
})

await test('a search returns candidates with a page url', async () => {
  const result = await searchFreesound('door knock')
  assert(result.error === null, `error was ${result.error}`)
  assert(result.results.length === 2, `expected 2 results, got ${result.results.length}`)
  assert(result.total === 683, `total was ${result.total}`)
  assert(/freesound\.org\/s\/865364\//.test(result.results[0].pageUrl), `pageUrl was ${result.results[0].pageUrl}`)
})

await test('the search asks for CC0 only', async () => {
  requests = []
  await searchFreesound('door knock')
  assert(requests.length === 1, `expected 1 request, got ${requests.length}`)
  const url = decodeURIComponent(requests[0]).replace(/\+/g, ' ')
  assert(/license:"Creative Commons 0"/.test(url), `the filter was missing: ${url}`)
})

await test('a search with no results returns an empty list, not an error', async () => {
  const result = await searchFreesound('nothing')
  assert(result.error === null, `error was ${result.error}`)
  assert(result.results.length === 0, `expected 0 results, got ${result.results.length}`)
  assert(result.total === 0, `total was ${result.total}`)
})

await test('an unreachable site returns an empty list and a reason', async () => {
  const result = await searchFreesound('door knock', {
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    },
  })
  assert(result.results.length === 0, 'an unreachable site should read as no results')
  assert(/could not be reached/.test(result.error), `error was ${result.error}`)
})

await test('a non-200 answer returns an empty list and a reason', async () => {
  const result = await searchFreesound('door knock', {
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  assert(result.results.length === 0, 'a failed answer should read as no results')
  assert(/503/.test(result.error), `error was ${result.error}`)
})

await test('a preview downloads into the cache', async () => {
  const [sound] = parseSearchPage(PAGE)
  const downloaded = await downloadPreview({ ...sound, previewUrl: `${base}/previews/865/865364_15375955-hq.mp3` })
  assert(downloaded.cached === false, 'the first download should not be a cache hit')
  const info = await stat(downloaded.path)
  assert(info.size > 0, 'the cached file should not be empty')
  assert(downloaded.path.startsWith(remoteCacheDir()), `path was ${downloaded.path}`)
  const bytes = await readFile(downloaded.path)
  assert(bytes.length === previewBytes.length, `bytes were ${bytes.length}, expected ${previewBytes.length}`)
})

await test('a second download of the same id does not touch the network', async () => {
  const [sound] = parseSearchPage(PAGE)
  requests = []
  const again = await downloadPreview({ ...sound, previewUrl: `${base}/previews/865/865364_15375955-hq.mp3` })
  assert(again.cached === true, 'the second download should be a cache hit')
  assert(requests.length === 0, `expected no requests, got ${requests.join(', ')}`)
})

await test('the cache directory can be redirected', async () => {
  assert(remoteCacheDir() === join(tmpDir, 'sfx-remote'), `cache dir was ${remoteCacheDir()}`)
})

await test('provenance records the id, page, author and licence', async () => {
  const [sound] = parseSearchPage(PAGE)
  const source = remoteSource(sound, { fetchedAt: '2026-11-12T00:00:00.000Z' })
  assert(source.kind === 'remote', `kind was ${source.kind}`)
  assert(source.provider === 'freesound', `provider was ${source.provider}`)
  assert(source.soundId === 865364, `soundId was ${source.soundId}`)
  assert(source.author === 'Valerie-Vivegnis', `author was ${source.author}`)
  assert(source.license === 'CC0-1.0', `license was ${source.license}`)
  assert(source.fetchedAt === '2026-11-12T00:00:00.000Z', `fetchedAt was ${source.fetchedAt}`)
  assert(/freesound\.org\/s\/865364\//.test(source.url), `url was ${source.url}`)
})

await test('a failed download leaves no partial file behind', async () => {
  const target = join(remoteCacheDir(), '999', '999-hq.mp3')
  await mkdir(dirname(target), { recursive: true })
  let error = null
  try {
    await downloadPreview({ soundId: 999, previewUrl: `${base}/previews/missing.mp3` })
  } catch (caught) {
    error = caught
  }
  assert(error, 'a 404 preview should fail')
  assert(!existsSync(target), 'no complete file should exist')
  assert(!existsSync(`${target}.part`), 'no partial file should be left behind')
})

await test('a sound without a preview url is refused', async () => {
  let error = null
  try {
    await downloadPreview({ soundId: 1234 })
  } catch (caught) {
    error = caught
  }
  assert(error, 'a sound with no preview url should be refused')
  assert(/no preview url/.test(error.message), `message was ${error.message}`)
})

// ---------------------------------------------------------------------------
// The placement path: an online sound becomes a project material with the
// provenance that says where it came from.

const { registerAllTools } = await import('../src/tools/index.js')
const { createProject, readMaterialIndex } = await import('../src/project/store.js')

if (!ffmpeg) {
  console.log('SKIP placement: ffmpeg is not available')
} else {
  const tools = new Map()
  registerAllTools({
    tools: { register: (definition) => tools.set(definition.name, definition) },
    logger: { info: () => {} },
    get: () => undefined,
  })
  const sfx = tools.get('anyaudio_sfx')
  const exec = { agent: { workspaceRoot: root } }
  const project = await createProject(root, { name: 'sfxlib-remote-placement' })

  await test('an online sound lands with its provenance', async () => {
    const [sound] = parseSearchPage(PAGE)
    const result = await sfx.execute({
      projectId: project.id,
      items: [{
        sound: 'freesound/865364',
        previewUrl: `${base}/previews/865/865364_15375955-hq.mp3`,
        title: sound.title,
        author: sound.author,
        startSec: 2,
      }],
    }, exec)
    assert(result.materials.length === 1, `expected 1 material, got ${result.materials.length}`)
    assert(result.materials[0].sound === 'freesound/865364', `sound was ${result.materials[0].sound}`)
    const index = await readMaterialIndex(root, project.id)
    const entry = index.materials[0]
    assert(entry.source.kind === 'remote', `source.kind was ${entry.source.kind}`)
    assert(entry.source.provider === 'freesound', `provider was ${entry.source.provider}`)
    assert(entry.source.soundId === 865364, `soundId was ${entry.source.soundId}`)
    assert(entry.source.license === 'CC0-1.0', `license was ${entry.source.license}`)
    assert(entry.source.author === 'Valerie-Vivegnis', `author was ${entry.source.author}`)
  })

  await test('placing the same online sound twice reuses one material', async () => {
    await sfx.execute({
      projectId: project.id,
      items: [{ sound: 'freesound/865364', startSec: 6 }],
    }, exec)
    const index = await readMaterialIndex(root, project.id)
    assert(index.materials.length === 1, `expected 1 material, got ${index.materials.length}`)
  })

  await test('an online sound with no cached preview and no url is refused', async () => {
    let error = null
    try {
      await sfx.execute({ projectId: project.id, items: [{ sound: 'freesound/777777' }] }, exec)
    } catch (caught) {
      error = caught
    }
    assert(error, 'an uncached online sound with no previewUrl should be refused')
    assert(/preview url/i.test(error.message), `message was ${error.message}`)
  })
}

// ---------------------------------------------------------------------------

server.close()
await rm(tmpDir, { recursive: true, force: true })
if (!hadAnyaudioDir) await rm(anyaudioDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
