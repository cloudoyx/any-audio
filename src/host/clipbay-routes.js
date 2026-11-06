/**
 * Clip bay HTTP surface (plan M2).
 *
 * Everything here hangs off the existing `/api/dsh-any-audio` prefix:
 *
 *   GET  /clipbay/projects?root=            list the workspace's projects
 *   GET  /clipbay/project?root=&id=         project.json + materials/index.json
 *   POST /clipbay/project?root=&id=         save a project
 *   GET  /clipbay/media?root=&project=&id=  material audio, Range supported
 *   GET  /clipbay/video?root=&project=      project video, Range supported
 *   GET  /clipbay/peaks?root=&project=&id=  waveform peaks
 *   POST /clipbay/render?root=&project=     start an export job
 *   GET  /clipbay/render?root=&project=&job= job status
 *   POST /clipbay/render/cancel             cancel a running export
 *
 * The media routes must skip the custom client header: `<audio>` / `<video>`
 * cannot send one. Their only protection is the same `sec-fetch-site`
 * rejection the settings bridge already applies (spec §12.5 ③).
 *
 * `root` is not trusted: it must be one of the workspaces DSH has registered,
 * which is what keeps a crafted request from reading any folder on the disk.
 */
import { basename, join, resolve } from 'node:path'
import { ProjectPathError, MATERIALS_DIR, projectDir, projectFile, resolveInside } from '../project/paths.js'
import { MaterialError, findMaterial, materialPath } from '../project/materials.js'
import { ProjectSchemaError } from '../project/schema.js'
import { exportProject } from '../project/render.js'
import { listProjects, projectExists, readMaterialIndex, readProject, saveProject } from '../project/store.js'
import { outputDir } from '../tools/shared.js'
import { describeError, json, readJsonBody, serveFile } from './http.js'

/** Host service keys for the workspace registry, newest first (matches mnemon / agent-teams). */
const WORKSPACE_SERVICE_KEYS = ['workspaceRegistry', 'workspace']

const CONTENT_TYPES = new Map([
  ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'],
  ['.webm', 'video/webm'],
  ['.avi', 'video/x-msvideo'],
])

function contentTypeOf(path) {
  const match = /\.[^./\\]+$/.exec(path)
  return (match && CONTENT_TYPES.get(match[0].toLowerCase())) || 'application/octet-stream'
}

/** Every workspace DSH has registered, as absolute paths. */
export function registeredWorkspaceRoots(ctx) {
  for (const key of WORKSPACE_SERVICE_KEYS) {
    let service
    try {
      service = typeof ctx?.get === 'function' ? ctx.get(key) : undefined
    } catch {
      service = undefined
    }
    if (!service || typeof service.list !== 'function') continue
    try {
      const list = service.list()
      if (!Array.isArray(list)) continue
      return list.flatMap((entry) =>
        typeof entry?.path === 'string' && entry.path.trim() ? [resolve(entry.path.trim())] : [],
      )
    } catch {
      // a broken registry must not turn every clip bay request into a 500
    }
  }
  return []
}

class RouteError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function workspaceRootOf(ctx, url) {
  const raw = String(url.searchParams.get('root') ?? '').trim()
  if (!raw) throw new RouteError(400, 'root is required')
  const wanted = resolve(raw)
  const allowed = registeredWorkspaceRoots(ctx)
  if (allowed.length === 0) {
    throw new RouteError(403, 'no DSH workspace is registered, so no project folder can be served')
  }
  if (!allowed.includes(wanted)) throw new RouteError(403, `root is not a registered workspace: ${raw}`)
  return wanted
}

function projectIdOf(url, param = 'id') {
  const raw = String(url.searchParams.get(param) ?? '').trim()
  if (!raw) throw new RouteError(400, `project id is required (${param}=)`)
  return raw
}

async function requireProject(workspaceRoot, projectId) {
  if (!(await projectExists(workspaceRoot, projectId))) {
    throw new RouteError(404, `no such project: ${projectId}`)
  }
  return readProject(workspaceRoot, projectId)
}

/**
 * Export jobs (plan M3, spec §10.3).
 *
 * A render is minutes of CPU and must be cancellable, so it runs as a job like
 * the font installs do: POST starts one, GET polls it, POST .../cancel aborts it.
 * The abort signal is the one `renderProject` threads all the way into ffmpeg —
 * cancellation that only stops the renderer waiting is exactly what the spec
 * forbids.
 */
const renderJobs = new Map()

function publicRenderJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    phase: job.phase,
    track: job.track ?? null,
    tracks: job.tracks ?? null,
    message: job.message,
    error: job.error ?? null,
    file: job.file ?? null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
  }
}

function startRenderJob({ workspaceRoot, project, format, outputPath, normalize = false }) {
  const job = {
    id: `rnd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    projectId: project.id,
    status: 'running',
    phase: 'render',
    message: '',
    startedAt: Date.now(),
    abort: new AbortController(),
  }
  renderJobs.set(job.id, job)
  exportProject({
    project,
    workspaceRoot,
    outputPath,
    format,
    normalize,
    // The first render of a draft measures the mix once and writes the number
    // into project.json; every later render reuses it (spec §10.2). The route
    // reads the project from disk, so writing it back here is safe.
    freezeNormalize: true,
    signal: job.abort.signal,
    onProgress: (progress) => {
      job.phase = progress.phase
      if (progress.track) job.track = progress.track
      if (progress.tracks) job.tracks = progress.tracks
      if (progress.phase === 'encode') job.message = `encoding ${progress.format}`
    },
  })
    .then((result) => {
      if (job.status === 'cancelled') return
      job.status = 'done'
      job.phase = 'done'
      job.file = result.file
      job.finishedAt = Date.now()
    })
    .catch((error) => {
      if (job.status === 'cancelled') return
      job.status = error?.name === 'AbortError' ? 'cancelled' : 'error'
      job.error = describeError(error)
      job.finishedAt = Date.now()
    })
  return job
}

/** Translate domain errors into status codes instead of leaking a 500. */
function statusOf(error) {
  if (error instanceof RouteError) return error.status
  if (error instanceof ProjectPathError || error instanceof ProjectSchemaError) return 400
  if (error instanceof MaterialError) return /is not in project/.test(error.message) ? 404 : 400
  return 500
}

async function handle(req, res, { url, method, path, ctx }) {
  if (path === '/clipbay/projects') {
    if (method !== 'GET') throw new RouteError(405, 'method not allowed')
    const root = workspaceRootOf(ctx, url)
    return json(res, 200, { ok: true, projects: await listProjects(root) })
  }

  if (path === '/clipbay/project') {
    const root = workspaceRootOf(ctx, url)
    const projectId = projectIdOf(url)
    if (method === 'GET') {
      const project = await requireProject(root, projectId)
      const index = await readMaterialIndex(root, projectId)
      return json(res, 200, { ok: true, project, materials: index.materials })
    }
    if (method === 'POST') {
      const body = await readJsonBody(req)
      const project = body?.project ?? body
      if (!project || typeof project !== 'object' || Array.isArray(project)) {
        throw new RouteError(400, 'request body must be a project object')
      }
      if (project.id !== projectId) {
        throw new RouteError(400, `project id in the body (${String(project.id)}) does not match the request (${projectId})`)
      }
      // The browser appends its own history entries on semantic operations, so
      // the route must not add a second one for every autosave.
      const saved = await saveProject(root, project, { by: 'user', note: '' })
      return json(res, 200, { ok: true, project: saved })
    }
    throw new RouteError(405, 'method not allowed')
  }

  if (path === '/clipbay/media') {
    if (method !== 'GET') throw new RouteError(405, 'method not allowed')
    const root = workspaceRootOf(ctx, url)
    const projectId = projectIdOf(url, 'project')
    const materialId = String(url.searchParams.get('id') ?? '').trim()
    if (!materialId) throw new RouteError(400, 'material id is required')
    await requireProject(root, projectId)
    const file = await materialPath(root, projectId, materialId)
    return serveFile(req, res, file, { contentType: contentTypeOf(file) })
  }

  if (path === '/clipbay/video') {
    if (method !== 'GET') throw new RouteError(405, 'method not allowed')
    const root = workspaceRootOf(ctx, url)
    const projectId = projectIdOf(url, 'project')
    const project = await requireProject(root, projectId)
    if (!project.video?.path) throw new RouteError(404, 'this project has no video')
    const file = resolveInside(projectDir(root, projectId), project.video.path, 'project.video.path')
    return serveFile(req, res, file, { contentType: contentTypeOf(file) })
  }

  if (path === '/clipbay/peaks') {
    if (method !== 'GET') throw new RouteError(405, 'method not allowed')
    const root = workspaceRootOf(ctx, url)
    const projectId = projectIdOf(url, 'project')
    const materialId = String(url.searchParams.get('id') ?? '').trim()
    if (!materialId) throw new RouteError(400, 'material id is required')
    const index = await readMaterialIndex(root, projectId)
    if (!findMaterial(index, materialId)) throw new RouteError(404, `material "${materialId}" is not in project "${projectId}"`)
    const file = resolveInside(projectDir(root, projectId), `${MATERIALS_DIR}/${materialId}.peaks.json`, 'peaks path')
    return serveFile(req, res, file, { contentType: 'application/json; charset=utf-8' })
  }

  if (path === '/clipbay/render') {
    const root = workspaceRootOf(ctx, url)
    if (method === 'GET') {
      const jobId = String(url.searchParams.get('job') ?? '').trim()
      if (!jobId) throw new RouteError(400, 'job id is required (job=)')
      const job = renderJobs.get(jobId)
      if (!job) throw new RouteError(404, `no such render job: ${jobId}`)
      return json(res, 200, { ok: true, job: publicRenderJob(job) })
    }
    if (method !== 'POST') throw new RouteError(405, 'method not allowed')
    const body = await readJsonBody(req)
    const projectId = projectIdOf(url, 'project')
    const project = await requireProject(root, projectId)
    const format = String(body?.format ?? (project.video ? 'mp4' : 'wav')).toLowerCase()
    if (!['wav', 'mp3', 'mp4'].includes(format)) {
      throw new RouteError(400, `unknown export format "${format}"; use wav, mp3 or mp4`)
    }
    const outputName = String(body?.output ?? '').trim()
    if (!outputName) throw new RouteError(400, 'output file name is required')
    // Only the file name is honoured: an export always lands in the workspace's
    // own output folder, so a crafted body cannot choose a path on the disk.
    const job = startRenderJob({
      workspaceRoot: root,
      project,
      format,
      outputPath: join(outputDir(root), basename(outputName)),
      // Off unless the caller asks: re-normalising on every export would undo the
      // volume changes the person made (spec §10.2).
      normalize: body?.normalize === true,
    })
    return json(res, 200, { ok: true, job: publicRenderJob(job) })
  }

  if (path === '/clipbay/render/cancel') {
    if (method !== 'POST') throw new RouteError(405, 'method not allowed')
    const body = await readJsonBody(req)
    const job = renderJobs.get(String(body?.jobId ?? '').trim())
    if (!job) throw new RouteError(404, 'no such render job')
    if (job.status === 'running') {
      job.status = 'cancelled'
      job.finishedAt = Date.now()
      job.abort.abort()
    }
    return json(res, 200, { ok: true, job: publicRenderJob(job) })
  }

  throw new RouteError(404, `unknown clip bay route ${path}`)
}

/** Only project read/write needs the page header; media elements cannot send one. */
export function needsClientHeader(path) {
  return path === '/clipbay/projects' || path === '/clipbay/project' || path === '/clipbay/render' || path === '/clipbay/render/cancel'
}

/**
 * Dispatch one clip bay request. `path` is the suffix after the prefix, e.g.
 * `/clipbay/project`.
 */
export async function handleClipBay(req, res, { url, method, path, ctx }) {
  try {
    return await handle(req, res, { url, method, path, ctx })
  } catch (error) {
    const status = statusOf(error)
    if (status >= 500) {
      const detail = String(error?.stack ?? '').split('\n').slice(0, 6).join('\n')
      return json(res, status, { ok: false, error: describeError(error), detail })
    }
    return json(res, status, { ok: false, error: describeError(error) })
  }
}

export { projectFile }
