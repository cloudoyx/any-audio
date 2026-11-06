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
 *
 * The media routes must skip the custom client header: `<audio>` / `<video>`
 * cannot send one. Their only protection is the same `sec-fetch-site`
 * rejection the settings bridge already applies (spec §12.5 ③).
 *
 * `root` is not trusted: it must be one of the workspaces DSH has registered,
 * which is what keeps a crafted request from reading any folder on the disk.
 */
import { resolve } from 'node:path'
import { ProjectPathError, MATERIALS_DIR, projectDir, projectFile, resolveInside } from '../project/paths.js'
import { MaterialError, findMaterial, materialPath } from '../project/materials.js'
import { ProjectSchemaError } from '../project/schema.js'
import { listProjects, projectExists, readMaterialIndex, readProject, saveProject } from '../project/store.js'
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

  throw new RouteError(404, `unknown clip bay route ${path}`)
}

/** Only project read/write needs the page header; media elements cannot send one. */
export function needsClientHeader(path) {
  return path === '/clipbay/projects' || path === '/clipbay/project'
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
