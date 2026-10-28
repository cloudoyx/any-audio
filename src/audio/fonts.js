import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, extname, join, resolve } from 'node:path'

export const FONT_EXTENSIONS = new Set(['.sf2', '.sf3', '.dls', '.sfogg'])

/**
 * Fonts are downloaded on demand instead of being bundled: GeneralUser GS
 * permits use inside software, but its author cannot verify every sample's
 * provenance, so the plugin keeps the license boundary at "user fetches it".
 */
export const RECOMMENDED_FONTS = [
  {
    id: 'generaluser',
    name: 'GeneralUser GS',
    file: 'GeneralUser-GS.sf2',
    url: 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2',
    bytes: 32319396,
    sha256: '9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe',
    license: 'GeneralUser GS License v2.0 (free for private/commercial music and for software use; sample provenance partly unverifiable)',
    note: 'Default bank. 287 GM presets, ~32 MB, balanced acoustic timbres; the only font guaranteed to have a drum kit.',
    default: true,
    suggested: true,
    scores: { piano: 5, chromatic: 6, organ: 5, guitar: 4, bass: 4, strings: 6, ensemble: 7, brass: 5, reed: 6, pipe: 7, synthLead: 4, synthPad: 5, ethnic: 6, percussive: 6, drums: 7, default: 5 },
    presetScores: [],
  },
  {
    id: 'musescore-general',
    name: 'MuseScore General',
    file: 'MuseScore_General.sf3',
    url: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3',
    bytes: 39900972,
    sha256: '5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3',
    license: 'MIT (FluidR3Mono by Michael Cowgill, FluidR3 by Frank Wen, adaptation by S. Christian Collins; keep the copyright notice)',
    licenseUrl: 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General_License.md',
    note: 'Suggested general-purpose orchestral bank. 309 GM/GM2 presets, ~40 MB, no drum-kit gap; a fuller orchestral bank than GeneralUser GS.',
    default: false,
    suggested: true,
    scores: { piano: 6, chromatic: 6, organ: 6, guitar: 5, bass: 6, strings: 8, ensemble: 8, brass: 7, reed: 7, pipe: 7, synthLead: 5, synthPad: 5, ethnic: 6, percussive: 6, drums: 7, default: 5 },
    presetScores: [],
  },
  {
    id: 'upright-piano',
    name: 'Upright Piano KW',
    file: 'UprightPianoKW-20220221.sf2',
    manual: 'https://freepats.zenvoid.org/Piano/UprightPianoKW/UprightPianoKW-SF2-20220221.7z',
    bytes: 57377848,
    archiveBytes: 28832466,
    sha256: 'd9f5157720963671906727ca2e12b3293fd822c831bb0de477dd1c5f3ad37108',
    license: 'CC0 1.0 (FreePats, sampled from a Kawai upright piano)',
    note: 'Single-instrument piano bank: it cannot substitute for other GM programs, so use it with "source" on piano tracks only.',
    scores: { piano: 9, chromatic: 3, organ: 2, guitar: 2, bass: 4, strings: 2, ensemble: 2, brass: 2, reed: 2, pipe: 2, synthLead: 2, synthPad: 2, ethnic: 2, percussive: 2, drums: 1, default: 2 },
    presetScores: [{ bank: 0, program: 0, score: 10 }],
  },
  {
    id: 'electric-guitar-clean',
    name: 'Electric Guitar Clean (FSBS)',
    file: 'EGuitarFSBS-clean-bridge-20260807.sf2',
    manual: 'https://github.com/freepats/electric-guitar-FSBS-clean/releases/tag/2026-08-07',
    bytes: 445922788,
    sha256: 'e66351135ff7c06ca0fee799688e767c917a085988ff29691c02f72c0a4ddabe',
    license: 'CC0 1.0 (FreePats, direct recording of a Fender electric guitar)',
    note: 'Single-instrument electric guitar bank (~446 MB after unpacking the 7z); use it with "source" on guitar tracks only.',
    scores: { piano: 2, chromatic: 2, organ: 1, guitar: 9, bass: 3, strings: 1, ensemble: 1, brass: 1, reed: 1, pipe: 1, synthLead: 2, synthPad: 2, ethnic: 1, percussive: 2, drums: 1, default: 2 },
    presetScores: [],
  },
]

export function findRecommended(id) {
  return RECOMMENDED_FONTS.find((font) => font.id === id) ?? null
}

export function findRecommendedByFile(fileName) {
  const base = basename(String(fileName ?? '')).toLowerCase()
  return RECOMMENDED_FONTS.find((font) => font.file.toLowerCase() === base) ?? null
}

/**
 * The shared font library: one directory per Windows/DSH user account, used by
 * every project and every agent session on this machine. Projects never get a
 * private font folder, otherwise a bank installed in one project is invisible
 * in the next one (and in the settings page).
 */
export function userFontDir() {
  const override = process.env.ANYAUDIO_FONT_DIR
  if (override && override.trim()) return resolve(override.trim())
  return join(homedir(), '.dsh', 'anyaudio', 'fonts')
}

export function fontSearchDirs() {
  const dirs = []
  const envValue = process.env.ANYAUDIO_FONTS
  if (envValue) for (const entry of envValue.split(delimiter)) if (entry.trim()) dirs.push(resolve(entry.trim()))
  dirs.push(userFontDir())
  return dirs
}

async function scanDir(dir, source) {
  const found = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    const path = join(dir, entry.name)
    const info = await stat(path)
    found.push({ path, name: entry.name, bytes: info.size, source })
  }
  return found
}

export async function listFonts() {
  const results = []
  const seen = new Set()
  const libraryDir = userFontDir()
  for (const dir of fontSearchDirs()) {
    const source = dir === libraryDir ? 'user' : 'env'
    for (const font of await scanDir(dir, source)) {
      if (seen.has(font.path)) continue
      seen.add(font.path)
      results.push(font)
    }
  }
  if (process.env.ANYAUDIO_FONT) {
    const explicit = resolve(process.env.ANYAUDIO_FONT)
    try {
      const info = await stat(explicit)
      if (info.isFile() && !seen.has(explicit)) results.unshift({ path: explicit, name: basename(explicit), bytes: info.size, source: 'env-file' })
    } catch {
      // Missing override is reported by resolveFont with a clearer message.
    }
  }
  return results
}

/**
 * The default font when the caller does not name one: prefer the recommended
 * default (GeneralUser GS), then any other recommended font, then whatever is
 * installed. Without this, the alphabetically first file would win and a
 * single-instrument bank could silently become the default for every track.
 */
export async function defaultFontPath() {
  const fonts = await listFonts()
  const preferred = RECOMMENDED_FONTS[0].id
  const recommended = fonts.find((font) => findRecommendedByFile(font.name)?.id === preferred)
  if (recommended) return recommended.path
  const anyRecommended = fonts.find((font) => findRecommendedByFile(font.name))
  return anyRecommended?.path ?? fonts[0]?.path ?? null
}

export async function resolveFont({ path, workspaceRoot } = {}) {
  if (path) {
    const candidate = resolve(workspaceRoot ?? process.cwd(), path)
    const info = await stat(candidate).catch(() => null)
    if (!info || !info.isFile()) throw new Error(`soundfont not found: ${candidate}`)
    return candidate
  }
  if (process.env.ANYAUDIO_FONT) {
    const candidate = resolve(process.env.ANYAUDIO_FONT)
    const info = await stat(candidate).catch(() => null)
    if (info?.isFile()) return candidate
  }
  const fallback = await defaultFontPath()
  if (fallback) return fallback
  throw new Error(
    [
      'no SoundFont installed.',
      `Looked in: ${fontSearchDirs().join(' | ')}`,
      'Install one with the anyaudio_sources tool (action "install"), or download a .sf2 manually and pass its path.',
    ].join(' '),
  )
}

export async function sha256File(path) {
  const raw = await import('node:fs/promises').then((fs) => fs.readFile(path))
  return createHash('sha256').update(raw).digest('hex')
}

async function download(url, target, { onProgress, signal } = {}) {
  let response
  try {
    response = await fetch(url, { redirect: 'follow', signal: signal ?? AbortSignal.timeout(180000) })
  } catch (error) {
    throw new Error(
      `download failed (${error instanceof Error ? error.message : String(error)}). ` +
        'If GitHub is unreachable on this network, download the .sf2 with your proxy and pass "fromPath" instead.',
    )
  }
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0) || undefined
  const temporary = `${target}.part`
  const chunks = []
  let received = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal?.aborted) throw new Error('download cancelled')
      chunks.push(Buffer.from(value))
      received += value.byteLength
      onProgress?.({ received, total })
    }
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  await writeFile(temporary, Buffer.concat(chunks))
  await rename(temporary, target).catch(async (error) => {
    await unlink(temporary).catch(() => {})
    throw error
  })
  return received
}

/**
 * Install a font into the shared library. Either from a URL (`url`) or by
 * copying a local file (`fromPath`); a relative `fromPath` resolves against the
 * caller's project folder.
 */
export async function installFont({ id = 'generaluser', url, fromPath, workspaceRoot, onProgress, signal } = {}) {
  const preset = url || fromPath ? null : RECOMMENDED_FONTS.find((entry) => entry.id === id)
  if (!preset) {
    const known = RECOMMENDED_FONTS.map((entry) => entry.id).join(', ')
    const targetUrl = url
    if (!targetUrl && !fromPath) throw new Error(`unknown font "${id}"; known ids: ${known}. Pass url or fromPath for custom fonts.`)
    const directory = userFontDir()
    await mkdir(directory, { recursive: true })
    const fileName = fromPath ? basename(fromPath) : basename(new URL(targetUrl).pathname) || 'font.sf2'
    const path = join(directory, FONT_EXTENSIONS.has(extname(fileName).toLowerCase()) ? fileName : `${fileName}.sf2`)
    const bytes = fromPath ? (await copyFile(resolve(workspaceRoot ?? process.cwd(), fromPath), path), (await stat(path)).size) : await download(targetUrl, path, { onProgress, signal })
    return { path, bytes, sha256: await sha256File(path), license: 'custom font — check its license before redistributing' }
  }

  const directory = userFontDir()
  await mkdir(directory, { recursive: true })
  const path = join(directory, preset.file)
  const existing = await stat(path).catch(() => null)
  if (existing?.isFile()) {
    const digest = await sha256File(path)
    if (!preset.sha256 || digest === preset.sha256) {
      return { path, bytes: existing.size, sha256: digest, license: preset.license, alreadyInstalled: true }
    }
    throw new Error(`existing font at ${path} does not match the expected checksum; delete it and install again`)
  }
  if (!preset.url) {
    throw new Error(
      `${preset.name} has to be downloaded manually: ${preset.manual ?? 'see the project page'}. ` +
        `Extract it to ${path} (keep this exact file name), then it becomes available as source "${preset.id}".`,
    )
  }
  const bytes = await download(preset.url, path, { onProgress, signal })
  const digest = await sha256File(path)
  if (preset.sha256 && digest !== preset.sha256) {
    await unlink(path).catch(() => {})
    throw new Error(`downloaded font checksum mismatch (expected ${preset.sha256}, got ${digest}); file removed`)
  }
  return { path, bytes: bytes || preset.bytes, sha256: digest, license: preset.license, licenseUrl: preset.licenseUrl }
}
