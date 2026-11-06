/**
 * Import audio and video into a project (spec §6.5, §11.2; plan M1).
 *
 * Two rules drive the implementation:
 *  - the original file is copied to sources/<id>.orig.<ext>, untouched, so a
 *    24 bit / 96 kHz source can be re-derived later;
 *  - the editable copy in materials/ is always 48 kHz stereo 16 bit WAV.
 *
 * Conversion is ffmpeg's job; its stderr is passed through verbatim instead of
 * being replaced by "import failed" (plan M1).
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { computePeaks, writePeaks } from '../audio/peaks.js'
import { conformChannels, parseWav, resample } from '../audio/wav.js'
import { MATERIALS_DIR, SOURCES_DIR, VIDEO_DIR, newMaterialId, projectDir, resolveInside } from './paths.js'
import { readProject, saveProject } from './store.js'
import { registerMaterial } from './materials.js'
import { nowIso } from './schema.js'

export const IMPORT_SAMPLE_RATE = 48000
export const IMPORT_CHANNELS = 2
export const IMPORT_BIT_DEPTH = 16

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff', '.caf'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'])

export class ImportError extends Error {
  constructor(message, { stderr = '' } = {}) {
    super(message)
    this.name = 'ImportError'
    this.stderr = stderr
  }
}

export function kindOfFile(path) {
  const ext = extname(String(path)).toLowerCase()
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  return null
}

/** Decode a WAV we already own (no ffmpeg) — the generated-material path. */
export async function readWavChannels(path) {
  const wav = parseWav(await readFile(path))
  let channels = conformChannels(wav.channels, IMPORT_CHANNELS)
  if (wav.sampleRate !== IMPORT_SAMPLE_RATE) channels = resample(channels, wav.sampleRate, IMPORT_SAMPLE_RATE)
  return { channels, durationSec: channels[0].length / IMPORT_SAMPLE_RATE }
}

function run(command, args, { signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise({ stderr })
      else reject(new ImportError(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`, { stderr }))
    })
  })
}

/** Read a media file's duration from ffmpeg's banner (no ffprobe dependency). */
export function probeMediaDuration(command, file, { signal } = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, ['-hide_banner', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal })
    } catch {
      resolvePromise(null)
      return
    }
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', () => resolvePromise(null))
    child.on('close', () => {
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
      if (!match) return resolvePromise(null)
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
      resolvePromise(Number.isFinite(seconds) && seconds > 0 ? seconds : null)
    })
  })
}

async function assertReadableFile(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    throw new ImportError(`cannot import "${path}": no such file`)
  }
  if (!info.isFile()) throw new ImportError(`cannot import "${path}": not a file`)
  if (info.size === 0) throw new ImportError(`cannot import "${path}": the file is empty`)
  return info
}

async function convertToInternalFormat(ffmpegCommand, sourcePath, targetPath, { signal } = {}) {
  await mkdir(resolve(targetPath, '..'), { recursive: true })
  try {
    await run(ffmpegCommand, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
      '-vn',
      '-ac', String(IMPORT_CHANNELS),
      '-ar', String(IMPORT_SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      targetPath,
    ], { signal })
  } catch (error) {
    throw new ImportError(
      `converting "${basename(sourcePath)}" to ${IMPORT_SAMPLE_RATE / 1000} kHz stereo WAV failed: ${error.message}`,
      { stderr: error.stderr ?? '' },
    )
  }
}

/** True when a WAV already satisfies the internal format, so it can be copied. */
async function isAlreadyInternalFormat(path) {
  try {
    const wav = parseWav(await readFile(path))
    return wav.sampleRate === IMPORT_SAMPLE_RATE && wav.channels.length === IMPORT_CHANNELS
  } catch {
    return false
  }
}

async function readAudioForPeaks(path) {
  try {
    return await readWavChannels(path)
  } catch (error) {
    throw new ImportError(`the internal copy ${basename(path)} is not a readable WAV: ${error.message}`)
  }
}

/**
 * Import one file into a project as a material.
 *
 * Audio: original kept, converted copy in materials/.
 * Video: file copied into video/, its audio extracted as a normal material with
 * kind "video-audio", and the project's video field pointed at the copy.
 */
export async function importFile(workspaceRoot, projectId, sourcePath, { findFfmpeg, signal } = {}) {
  const project = await readProject(workspaceRoot, projectId)
  const dir = projectDir(workspaceRoot, projectId)
  const from = isAbsolute(sourcePath) ? sourcePath : resolve(workspaceRoot, sourcePath)
  await assertReadableFile(from)
  const role = kindOfFile(from)
  if (!role) throw new ImportError(`unsupported file type "${extname(from) || '(no extension)'}" for ${basename(from)}`)

  const ffmpeg = findFfmpeg?.() ?? null
  const id = newMaterialId()
  const ext = extname(from).toLowerCase().replace(/^\./, '') || 'bin'
  const materialCopy = resolveInside(dir, `${MATERIALS_DIR}/${id}.wav`)
  const peaksRel = `${MATERIALS_DIR}/${id}.peaks.json`
  await mkdir(resolve(dir, MATERIALS_DIR), { recursive: true })
  await mkdir(resolve(dir, SOURCES_DIR), { recursive: true })
  await copyFile(from, resolveInside(dir, `${SOURCES_DIR}/${id}.orig.${ext}`))

  if (role === 'video') {
    if (!ffmpeg) throw new ImportError('ffmpeg not found; importing a video needs it to extract the original sound track (set ANYAUDIO_FFMPEG or add ffmpeg to PATH)')
    const videoName = `${id}.${ext}`
    const videoCopy = resolveInside(dir, `${VIDEO_DIR}/${videoName}`)
    await mkdir(resolve(dir, VIDEO_DIR), { recursive: true })
    await copyFile(from, videoCopy)
    const durationSec = await probeMediaDuration(ffmpeg.command, videoCopy, { signal })
    if (!durationSec) throw new ImportError(`could not read the duration of "${basename(from)}"`)
    await convertToInternalFormat(ffmpeg.command, videoCopy, materialCopy, { signal })
    const decoded = await readAudioForPeaks(materialCopy)
    await writePeaks(resolveInside(dir, peaksRel), computePeaks(decoded.channels, decoded.durationSec))

    const material = await registerMaterial(workspaceRoot, projectId, {
      id,
      file: `${MATERIALS_DIR}/${id}.wav`,
      durationSec: decoded.durationSec,
      sampleRate: IMPORT_SAMPLE_RATE,
      channels: IMPORT_CHANNELS,
      kind: 'video-audio',
      bytes: (await stat(materialCopy)).size,
      source: {
        kind: 'imported',
        originalName: basename(from),
        originalFormat: ext,
        importedAt: nowIso(),
        original: `${SOURCES_DIR}/${id}.orig.${ext}`,
        video: `${VIDEO_DIR}/${videoName}`,
      },
    })
    const updated = { ...project, video: { path: `${VIDEO_DIR}/${videoName}`, durationSec, locked: true } }
    await saveProject(workspaceRoot, updated, { by: 'agent', note: `imported video ${basename(from)}` })
    return { material, video: updated.video, peaks: peaksRel }
  }

  // Audio import. A 48 kHz stereo PCM WAV is already in the internal format, so
  // it is copied instead of re-encoded; everything else goes through ffmpeg so
  // the stored copy really is 48 kHz stereo 16 bit.
  const canCopy = ext === 'wav' && (await isAlreadyInternalFormat(from))
  if (canCopy) {
    await copyFile(from, materialCopy)
  } else {
    if (!ffmpeg) {
      throw new ImportError(`ffmpeg not found; importing ${basename(from)} needs it to convert to ${IMPORT_SAMPLE_RATE / 1000} kHz stereo WAV`)
    }
    await convertToInternalFormat(ffmpeg.command, from, materialCopy, { signal })
  }

  const decoded = await readAudioForPeaks(materialCopy)
  await writePeaks(resolveInside(dir, peaksRel), computePeaks(decoded.channels, decoded.durationSec))

  const material = await registerMaterial(workspaceRoot, projectId, {
    id,
    file: `${MATERIALS_DIR}/${id}.wav`,
    durationSec: decoded.durationSec,
    sampleRate: IMPORT_SAMPLE_RATE,
    channels: IMPORT_CHANNELS,
    kind: 'imported',
    bytes: (await stat(materialCopy)).size,
    source: {
      kind: 'imported',
      originalName: basename(from),
      originalFormat: ext,
      importedAt: nowIso(),
      original: `${SOURCES_DIR}/${id}.orig.${ext}`,
    },
  })
  return { material, video: null, peaks: peaksRel }
}

/**
 * Register a material we generated ourselves (a tool output already in the
 * internal format). The caller supplies the creation snapshot contents.
 */
export async function importGeneratedMaterial(workspaceRoot, projectId, {
  sourcePath, kind, snapshotKind, snapshot, tool, label,
}) {
  const dir = projectDir(workspaceRoot, projectId)
  await assertReadableFile(sourcePath)
  const id = newMaterialId()
  const materialCopy = resolveInside(dir, `${MATERIALS_DIR}/${id}.wav`)
  await mkdir(resolve(dir, MATERIALS_DIR), { recursive: true })
  await mkdir(resolve(dir, SOURCES_DIR), { recursive: true })
  await copyFile(sourcePath, materialCopy)

  const decoded = await readAudioForPeaks(materialCopy)
  const peaksRel = `${MATERIALS_DIR}/${id}.peaks.json`
  await writePeaks(resolveInside(dir, peaksRel), computePeaks(decoded.channels, decoded.durationSec))

  let snapshotRel = null
  if (snapshot && snapshotKind) {
    snapshotRel = `${SOURCES_DIR}/${id}.${snapshotKind}.json`
    // A snapshot is frozen at creation time (spec §6.6): a later edit to the
    // agent's own score file must not change what this material was made from.
    await writeFile(resolveInside(dir, snapshotRel), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  }

  const material = await registerMaterial(workspaceRoot, projectId, {
    id,
    file: `${MATERIALS_DIR}/${id}.wav`,
    durationSec: decoded.durationSec,
    sampleRate: IMPORT_SAMPLE_RATE,
    channels: IMPORT_CHANNELS,
    kind,
    bytes: (await stat(materialCopy)).size,
    source: { kind: 'generated', snapshot: snapshotRel, tool: tool ?? null, label: label ?? null },
  })
  return { material, peaks: peaksRel }
}
