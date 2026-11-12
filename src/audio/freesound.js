/**
 * The online CC0 fallback: Freesound's public search page and its preview CDN.
 *
 * The library is the first source and the synthesised effects are the last; this
 * sits between them, for the sound the local packs simply do not have.
 *
 * Two facts shape the implementation:
 *
 * - the search page is HTML, and the fields we need are all in `data-` attributes
 *   on each result block, so a small parser is enough — no DOM, no dependency;
 * - the preview files live on a public CDN and need no key, so the whole path is
 *   zero-config. Only the original uploads need OAuth2, and those are not used.
 *
 * Nothing here builds an index or crawls: one search is one request, and only the
 * previews that were actually placed are cached.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const FREESOUND_SEARCH_URL = 'https://freesound.org/search/'
export const FREESOUND_SOUND_URL = 'https://freesound.org/s/'
export const FREESOUND_LICENSE = 'CC0-1.0'

/** The site root, overridable so a test can point at a local server. */
export function freesoundBaseUrl() {
  const override = process.env.ANYAUDIO_FREESOUND_BASE
  if (override && override.trim()) return override.trim().replace(/\/+$/, '')
  return 'https://freesound.org'
}

export class FreesoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FreesoundError'
  }
}

/** Where downloaded previews are kept. Shared by the machine, like the packs. */
export function remoteCacheDir() {
  const override = process.env.ANYAUDIO_SFX_REMOTE_DIR
  if (override && override.trim()) return resolve(override.trim())
  return join(homedir(), '.dsh', 'anyaudio', 'sfx-remote')
}

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function attribute(block, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(block)
  return match ? decodeEntities(match[1]) : null
}

/**
 * Parse one search page into candidate rows.
 *
 * The page is split on the result marker rather than parsed as a document: the
 * fields are attributes on the player element, and a document parser would add a
 * dependency to read six strings.
 */
export function parseSearchPage(html) {
  const text = String(html ?? '')
  const chunks = text.split('bw-search__result')
  const results = []
  for (const chunk of chunks.slice(1)) {
    const soundId = Number(attribute(chunk, 'data-sound-id'))
    const mp3 = attribute(chunk, 'data-mp3')
    if (!Number.isFinite(soundId) || soundId <= 0 || !mp3) continue
    const title = attribute(chunk, 'data-title') ?? ''
    const durationSec = Number(attribute(chunk, 'data-duration'))
    const author = attribute(chunk, 'data-username') ?? ''
    const downloads = Number(attribute(chunk, 'data-num-downloads'))
    const ratingMatch = /Average rating of ([\d.]+)/.exec(chunk)
    results.push({
      soundId,
      title: title.trim(),
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
      author,
      downloads: Number.isFinite(downloads) ? downloads : null,
      rating: ratingMatch ? Number(ratingMatch[1]) : null,
      // The page links the low-quality preview; the high-quality one is the same
      // path with a different suffix and is served by the same CDN.
      previewUrl: mp3.replace(/-lq\.mp3$/, '-hq.mp3'),
      pageUrl: `${FREESOUND_SOUND_URL}${soundId}/`,
    })
  }
  return results
}

/** The total the page reports, when it says so. */
export function parseTotal(html) {
  const match = /([\d,]+)\s+sounds/.exec(String(html ?? ''))
  return match ? Number(match[1].replace(/,/g, '')) : null
}

function searchUrl(query, page = 1) {
  const params = new URLSearchParams({
    q: query,
    f: `license:"Creative Commons 0"`,
    page: String(page),
  })
  return `${freesoundBaseUrl()}/search/?${params.toString()}`
}

/**
 * Search the public page for CC0 sounds.
 *
 * A network failure is not an error the caller has to handle: the online source
 * is the second of three, and a search that cannot reach it should behave as if
 * it had found nothing there. The reason is returned so a log can say why.
 */
export async function searchFreesound(query, { limit = 10, signal, fetchImpl = fetch } = {}) {
  const text = String(query ?? '').trim()
  if (!text) return { results: [], total: 0, error: 'a search query is required' }
  let response
  try {
    response = await fetchImpl(searchUrl(text), {
      signal,
      headers: {
        // The page is served to browsers; a plain client user agent gets the same
        // HTML, but naming a browser keeps the response shape stable.
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
    })
  } catch (error) {
    return { results: [], total: 0, error: `freesound could not be reached: ${error.message}` }
  }
  if (!response.ok) {
    return { results: [], total: 0, error: `freesound answered ${response.status}` }
  }
  let html
  try {
    html = await response.text()
  } catch (error) {
    return { results: [], total: 0, error: `freesound response could not be read: ${error.message}` }
  }
  const all = parseSearchPage(html)
  return {
    results: all.slice(0, Math.max(1, Number(limit) || 10)),
    total: parseTotal(html) ?? all.length,
    error: null,
  }
}

function cachePath(soundId) {
  return join(remoteCacheDir(), String(soundId), `${soundId}-hq.mp3`)
}

/**
 * Download one preview into the cache, or return the copy already there.
 *
 * The `.part` → rename dance is the same one the font installer uses: a killed
 * download must not leave a half file that a later run would treat as complete.
 */
export async function downloadPreview(sound, { signal, fetchImpl = fetch } = {}) {
  const soundId = Number(sound?.soundId)
  if (!Number.isFinite(soundId) || soundId <= 0) throw new FreesoundError('a sound id is required')
  const target = cachePath(soundId)
  const existing = await stat(target).catch(() => null)
  if (existing?.isFile() && existing.size > 0) return { path: target, cached: true }

  const url = String(sound.previewUrl ?? '')
  if (!url) throw new FreesoundError(`sound ${soundId} has no preview url`)
  await mkdir(join(remoteCacheDir(), String(soundId)), { recursive: true })
  const partial = `${target}.part`
  let response
  try {
    response = await fetchImpl(url, { signal })
  } catch (error) {
    throw new FreesoundError(`the preview for sound ${soundId} could not be downloaded: ${error.message}`)
  }
  if (!response.ok) throw new FreesoundError(`the preview for sound ${soundId} answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new FreesoundError(`the preview for sound ${soundId} was empty`)
  await writeFile(partial, bytes)
  await rename(partial, target)
  return { path: target, cached: false, bytes: bytes.length }
}

/** The provenance record written into a project material. */
export function remoteSource(sound, { fetchedAt = new Date().toISOString() } = {}) {
  return {
    kind: 'remote',
    provider: 'freesound',
    soundId: Number(sound.soundId),
    url: sound.pageUrl ?? `${FREESOUND_SOUND_URL}${sound.soundId}/`,
    author: sound.author ?? '',
    license: FREESOUND_LICENSE,
    fetchedAt,
  }
}

/** Read a cached preview back, for tests and for a re-import. */
export async function readCachedPreview(soundId) {
  return readFile(cachePath(soundId))
}

export async function clearRemoteCache() {
  await rm(remoteCacheDir(), { recursive: true, force: true })
}
