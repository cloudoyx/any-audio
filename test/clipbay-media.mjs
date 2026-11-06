// Clip bay API acceptance (plan M2): mounts the real host routes on a local HTTP
// server with a workspace registry stub, then exercises every clip bay endpoint.
//
// Nothing here touches the user's real workspace, config or sound library: the
// workspace root is a scratch folder and the registry is a stub, which is the
// same redirection the existing settings test uses.
import http from 'node:http'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerAnyAudioRoutes } from '../src/host/routes.js'
import { createProject, readProject, writeMaterialIndex } from '../src/project/store.js'
import { materialsDir, projectDir, videoDir } from '../src/project/paths.js'
import { encodeWav } from '../src/audio/wav.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = join(root, '.anyaudio', 'test-tmp-media')
const workspaceRoot = join(scratch, 'workspace')
const otherWorkspace = join(scratch, 'other')

await rm(scratch, { recursive: true, force: true })
await mkdir(workspaceRoot, { recursive: true })
await mkdir(otherWorkspace, { recursive: true })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// A registered workspace is the only thing the routes will serve from, so the
// stub registry *is* the security boundary under test.
const registry = { list: () => [{ path: workspaceRoot, title: 'scratch' }] }
let handler
const webServer = { register: (route) => { handler = route.handler; return () => {} } }
const ctx = {
  get: (id) => (id === 'webServer' ? webServer : id === 'workspaceRegistry' ? registry : undefined),
  inject: (_, fn) => fn(ctx),
  effect: (fn) => fn(),
  logger: { info: () => {} },
}
registerAnyAudioRoutes(ctx, { log: { info: () => {} }, workspaceRoot })

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
  })
})

// --- fixtures ---------------------------------------------------------------

const projectId = 'prj_media_test'
const project = await createProject(workspaceRoot, { id: projectId, name: 'Media fixture', by: 'user', note: 'fixture' })

// 1 second of stereo tone as the material file, 48000 Hz / 16 bit.
const sampleRate = 48000
const frames = sampleRate
const left = new Float32Array(frames)
const right = new Float32Array(frames)
for (let i = 0; i < frames; i++) {
  left[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5
  right[i] = Math.sin((2 * Math.PI * 550 * i) / sampleRate) * 0.5
}
const wavBytes = encodeWav({ sampleRate, channels: [left, right], bitDepth: 16 })
await writeFile(join(materialsDir(workspaceRoot, projectId), 'mat_tones.wav'), wavBytes)
await writeFile(
  join(materialsDir(workspaceRoot, projectId), 'mat_tones.peaks.json'),
  JSON.stringify({ bucketsPerSecond: 50, buckets: 50, durationSec: 1, min: [-0.5], max: [0.5] }),
)
await writeMaterialIndex(workspaceRoot, projectId, {
  materials: [
    {
      id: 'mat_tones',
      file: 'materials/mat_tones.wav',
      durationSec: 1,
      sampleRate,
      channels: 2,
      kind: 'imported',
      bytes: wavBytes.length,
      source: { kind: 'imported', originalName: 'tones.wav', originalFormat: 'wav', importedAt: '2026-11-06T00:00:00Z' },
    },
  ],
})

// A second project so "list" has more than one row, and a video file for the
// video route.
await createProject(workspaceRoot, { id: 'prj_media_second', name: 'Second fixture', by: 'user', note: 'fixture' })
const videoBytes = Buffer.alloc(2048, 7)
await mkdir(videoDir(workspaceRoot, projectId), { recursive: true })
await writeFile(join(videoDir(workspaceRoot, projectId), 'clip.mp4'), videoBytes)
project.video = { path: 'video/clip.mp4', durationSec: 2, locked: true }
await writeFile(join(projectDir(workspaceRoot, projectId), 'project.json'), JSON.stringify({ ...project }))

// --- run --------------------------------------------------------------------

server.listen(0, '127.0.0.1', async () => {
  const origin = `http://127.0.0.1:${server.address().port}`
  const base = `${origin}/api/dsh-any-audio`
  const client = { 'x-any-audio-client': 'any-audio/1' }
  const query = (path) => `${base}${path}`
  const getJson = async (path, headers = client) => (await fetch(query(path), { headers })).json()
  const postJson = async (path, body, headers = client) =>
    (await fetch(query(path), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  const mediaUrl = (id) => query(`/clipbay/media?root=${encodeURIComponent(workspaceRoot)}&project=${projectId}&id=${id}`)

  let passed = 0
  let failed = 0
  const step = async (name, fn) => {
    try {
      await fn()
      passed++
      console.log('PASS', name)
    } catch (error) {
      failed++
      console.log('FAIL', name, '—', error.message)
    }
  }

  const rootParam = encodeURIComponent(workspaceRoot)
  const projectQuery = `/clipbay/project?root=${rootParam}&id=${projectId}`

  await step('projects lists the workspace folders newest first', async () => {
    const body = await getJson(`/clipbay/projects?root=${rootParam}`)
    assert(body.ok, `not ok: ${JSON.stringify(body)}`)
    assert(body.projects.length === 2, `expected two projects, got ${body.projects.length}`)
    assert(body.projects.some((row) => row.id === projectId), 'fixture project missing from the list')
    assert(typeof body.projects[0].trackCount === 'number', 'summary rows should carry a track count')
  })

  await step('project read returns project.json and the material index', async () => {
    const body = await getJson(projectQuery)
    assert(body.ok, `not ok: ${JSON.stringify(body)}`)
    assert(body.project.id === projectId, `wrong project id ${body.project.id}`)
    assert(body.materials.length === 1 && body.materials[0].id === 'mat_tones', 'material index missing')
    assert(body.project.video?.path === 'video/clip.mp4', 'video record missing')
  })

  await step('project save round-trips without adding a history entry', async () => {
    const loaded = await getJson(projectQuery)
    const next = { ...loaded.project, masterFaderDb: -3.5 }
    const before = next.history.length
    const saved = await postJson(projectQuery, { project: next })
    assert(saved.ok, `save failed: ${JSON.stringify(saved)}`)
    const again = await readProject(workspaceRoot, projectId)
    assert(again.masterFaderDb === -3.5, 'saved field did not persist')
    assert(again.history.length === before, `an autosave must not append history (${before} -> ${again.history.length})`)
    // durationSec is derived from content on every save, never taken from the input.
    assert(again.durationSec === 2, `durationSec should follow the 2s video, got ${again.durationSec}`)
  })

  await step('project save rejects an id that does not match the request', async () => {
    const loaded = await getJson(projectQuery)
    const body = await postJson(projectQuery, { project: { ...loaded.project, id: 'prj_somewhere_else' } })
    assert(body.ok === false && /does not match/.test(body.error), `expected an id mismatch error, got ${JSON.stringify(body)}`)
  })

  await step('unknown project is a 404, not a 500', async () => {
    const response = await fetch(query(`/clipbay/project?root=${rootParam}&id=prj_missing`), { headers: client })
    assert(response.status === 404, `expected 404, got ${response.status}`)
  })

  await step('media without Range returns 200 and the whole file', async () => {
    const response = await fetch(mediaUrl('mat_tones'))
    assert(response.status === 200, `expected 200, got ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    assert(body.length === wavBytes.length, `expected ${wavBytes.length} bytes, got ${body.length}`)
    assert(response.headers.get('accept-ranges') === 'bytes', 'Accept-Ranges: bytes is missing')
    assert(body.equals(wavBytes), 'served bytes differ from the file on disk')
  })

  await step('media serves audio/wav without the page header', async () => {
    const response = await fetch(mediaUrl('mat_tones'))
    assert(response.headers.get('content-type') === 'audio/wav', `wrong content-type ${response.headers.get('content-type')}`)
    await response.arrayBuffer()
  })

  await step('Range bytes=0-1023 returns 206 with exactly 1024 bytes', async () => {
    const response = await fetch(mediaUrl('mat_tones'), { headers: { range: 'bytes=0-1023' } })
    assert(response.status === 206, `expected 206, got ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    assert(body.length === 1024, `expected 1024 bytes, got ${body.length}`)
    assert(body.equals(wavBytes.subarray(0, 1024)), 'range bytes differ from the file')
    assert(
      response.headers.get('content-range') === `bytes 0-1023/${wavBytes.length}`,
      `wrong Content-Range: ${response.headers.get('content-range')}`,
    )
  })

  await step('an open-ended Range runs to the last byte', async () => {
    const start = wavBytes.length - 100
    const response = await fetch(mediaUrl('mat_tones'), { headers: { range: `bytes=${start}-` } })
    assert(response.status === 206, `expected 206, got ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    assert(body.length === 100, `expected 100 bytes, got ${body.length}`)
    assert(body.equals(wavBytes.subarray(start)), 'tail bytes differ from the file')
  })

  await step('a suffix Range returns the last N bytes', async () => {
    const response = await fetch(mediaUrl('mat_tones'), { headers: { range: 'bytes=-64' } })
    assert(response.status === 206, `expected 206, got ${response.status}`)
    const body = Buffer.from(await response.arrayBuffer())
    assert(body.equals(wavBytes.subarray(wavBytes.length - 64)), 'suffix range bytes differ from the file')
  })

  await step('a Range past the end returns 416', async () => {
    const response = await fetch(mediaUrl('mat_tones'), { headers: { range: `bytes=${wavBytes.length + 10}-` } })
    assert(response.status === 416, `expected 416, got ${response.status}`)
    assert(response.headers.get('content-range') === `bytes */${wavBytes.length}`, '416 must advertise the real length')
    await response.arrayBuffer()
  })

  await step('peaks are served as JSON for a registered material', async () => {
    const response = await fetch(query(`/clipbay/peaks?root=${rootParam}&project=${projectId}&id=mat_tones`))
    assert(response.status === 200, `expected 200, got ${response.status}`)
    const body = await response.json()
    assert(body.buckets === 50, `expected 50 buckets, got ${body.buckets}`)
  })

  await step('peaks for an unregistered material is a 404', async () => {
    const response = await fetch(query(`/clipbay/peaks?root=${rootParam}&project=${projectId}&id=mat_nope`))
    assert(response.status === 404, `expected 404, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('the video route serves the picture with Range support', async () => {
    const url = query(`/clipbay/video?root=${rootParam}&project=${projectId}`)
    const whole = await fetch(url)
    assert(whole.status === 200, `expected 200, got ${whole.status}`)
    assert(whole.headers.get('content-type') === 'video/mp4', `wrong content-type ${whole.headers.get('content-type')}`)
    await whole.arrayBuffer()
    const partial = await fetch(url, { headers: { range: 'bytes=0-99' } })
    assert(partial.status === 206, `expected 206, got ${partial.status}`)
    const body = Buffer.from(await partial.arrayBuffer())
    assert(body.length === 100, `expected 100 bytes, got ${body.length}`)
  })

  await step('a project without a video answers 404 on the video route', async () => {
    const response = await fetch(query(`/clipbay/video?root=${rootParam}&project=prj_media_second`))
    assert(response.status === 404, `expected 404, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('an unregistered workspace root is refused', async () => {
    const response = await fetch(
      query(`/clipbay/projects?root=${encodeURIComponent(otherWorkspace)}`),
      { headers: client },
    )
    assert(response.status === 403, `expected 403, got ${response.status}`)
    const body = await response.json()
    assert(/not a registered workspace/.test(body.error), `unexpected error: ${body.error}`)
  })

  await step('a missing root parameter is a 400', async () => {
    const response = await fetch(query('/clipbay/projects'), { headers: client })
    assert(response.status === 400, `expected 400, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('a traversal project id is refused', async () => {
    const response = await fetch(
      query(`/clipbay/project?root=${rootParam}&id=${encodeURIComponent('../escape')}`),
      { headers: client },
    )
    assert(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('a traversal material id is refused', async () => {
    const response = await fetch(
      query(`/clipbay/peaks?root=${rootParam}&project=${projectId}&id=${encodeURIComponent('../../project')}`),
    )
    assert(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('a traversal video path in project.json is refused', async () => {
    const escaping = { ...(await readProject(workspaceRoot, 'prj_media_second')), video: { path: '../outside.mp4', durationSec: 1, locked: true } }
    await writeFile(join(projectDir(workspaceRoot, 'prj_media_second'), 'project.json'), JSON.stringify(escaping))
    const response = await fetch(query(`/clipbay/video?root=${rootParam}&project=prj_media_second`))
    assert(response.status === 400, `expected 400, got ${response.status}`)
    const body = await response.json()
    assert(/must not escape|must be relative|must stay inside/.test(body.error), `unexpected error: ${body.error}`)
  })

  await step('a cross-site request is refused', async () => {
    const response = await fetch(query(`/clipbay/projects?root=${rootParam}`), {
      headers: { ...client, 'sec-fetch-site': 'cross-site' },
    })
    assert(response.status === 403, `expected 403, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('a cross-site media request is refused too', async () => {
    const response = await fetch(mediaUrl('mat_tones'), { headers: { 'sec-fetch-site': 'cross-site' } })
    assert(response.status === 403, `expected 403, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('project write without the page header is refused', async () => {
    const response = await fetch(query(`/clipbay/project?root=${rootParam}&id=${projectId}`))
    assert(response.status === 403, `expected 403, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('an unknown clip bay route is a 404', async () => {
    const response = await fetch(query(`/clipbay/nothing?root=${rootParam}`), { headers: client })
    assert(response.status === 404, `expected 404, got ${response.status}`)
    await response.arrayBuffer()
  })

  await step('the settings routes still require the page header', async () => {
    const response = await fetch(query('/state'))
    assert(response.status === 403, `expected 403, got ${response.status}`)
    await response.arrayBuffer()
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  server.close()
  await rm(scratch, { recursive: true, force: true })
  if (failed > 0) process.exitCode = 1
})
