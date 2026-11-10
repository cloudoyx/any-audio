/**
 * Small HTTP helpers shared by the settings bridge and the clip bay routes.
 *
 * The web server hands plugins a raw node:http request/response pair (spec
 * §12.5 ③), so everything from status codes to Range has to be spelled out here.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

export function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

export async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

export function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Parse one Range header. Returns null when the whole file should be sent,
 * 'invalid' when the client asked for bytes past the end (416), or the
 * inclusive start/end pair. Only the single-range form is supported; a
 * multi-range request falls back to the full body, which is legal.
 */
export function parseRange(header, total) {
  const raw = String(header ?? '').trim()
  if (!raw.startsWith('bytes=')) return null
  const spec = raw.slice('bytes='.length).trim()
  if (spec.includes(',')) return null
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (!match) return null
  const [, first, last] = match
  if (first === '' && last === '') return null
  let start
  let end
  if (first === '') {
    const suffix = Number(last)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(first)
    end = last === '' ? total - 1 : Number(last)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 'invalid'
    end = Math.min(end, total - 1)
    if (start >= total) return 'invalid'
  }
  return { start, end }
}

/** Serve one file with `Accept-Ranges` / `206` / `Content-Range` / `416` (plan M2). */
export async function serveFile(req, res, filePath, { contentType, cacheControl = 'no-store' } = {}) {
  const base = { 'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': cacheControl }
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      json(res, 404, { ok: false, error: `file not found: ${filePath}` })
      return
    }
    throw error
  }
  if (!info.isFile()) {
    json(res, 404, { ok: false, error: `not a file: ${filePath}` })
    return
  }
  const total = info.size
  const range = parseRange(req.headers.range, total)
  if (range === 'invalid') {
    res.writeHead(416, { ...base, 'content-range': `bytes */${total}` })
    res.end()
    return
  }
  if (!range) {
    res.writeHead(200, { ...base, 'content-length': String(total) })
    createReadStream(filePath).pipe(res)
    return
  }
  res.writeHead(206, {
    ...base,
    'content-length': String(range.end - range.start + 1),
    'content-range': `bytes ${range.start}-${range.end}/${total}`,
  })
  createReadStream(filePath, { start: range.start, end: range.end }).pipe(res)
}
