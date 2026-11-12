/**
 * Placing one sound from the shared library into a project.
 *
 * The library is machine-wide; a project is not. So the moment a sound is
 * actually used, that one file is converted into the project's own
 * `materials/` folder as 48 kHz stereo 16 bit WAV — the format the renderer
 * reads — and registered like any other material.
 *
 * Only the sound that was used is copied. A pack of 237 sounds never lands in a
 * project; a project holds the handful it actually plays.
 *
 * The same sound placed three times is still one material: the second and third
 * placements reuse the record the first one created, because a material is a
 * file and a clip is a use of it. That is also what keeps a per-clip gain from
 * turning into three copies of the same audio.
 */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { analyzeChannels, writePeaks } from '../audio/peaks.js'
import { remoteSource } from '../audio/freesound.js'
import { conformChannels, parseWav } from '../audio/wav.js'
import { MATERIALS_DIR, newMaterialId, projectDir, resolveInside } from './paths.js'
import { readMaterialIndex, writeMaterialIndex } from './store.js'
import { registerMaterial } from './materials.js'
import { IMPORT_CHANNELS, IMPORT_SAMPLE_RATE, ImportError, probeMediaDuration } from './import.js'
import { nowIso } from './schema.js'

export class LibraryImportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LibraryImportError'
  }
}

function run(command, args, { signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    // Imported lazily so this module stays usable in tests that never convert.
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(command, args, { windowsHide: true, signal })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolvePromise({ stderr })
        else reject(new LibraryImportError(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`))
      })
    }, reject)
  })
}

/** The material already standing for this library sound, if the project has one. */
export function findLibraryMaterial(index, packId, soundName) {
  return (index?.materials ?? []).find(
    (entry) => entry.source?.kind === 'library' && entry.source.packId === packId && entry.source.soundName === soundName,
  ) ?? null
}

/**
 * Convert one library file into the project and register it.
 *
 * `sound` is the resolved record from `sfx-library.js`: it carries `packId`,
 * `name`, `file` and `durationSec`. `packDir` is the pack's directory on disk.
 */
export async function importLibraryMaterial(workspaceRoot, projectId, { sound, packDir, findFfmpeg, signal }) {
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const existing = findLibraryMaterial(index, sound.packId, sound.name)
  if (existing) return { material: existing, reused: true }

  const sourcePath = join(packDir, sound.file)
  let info
  try {
    info = await stat(sourcePath)
  } catch {
    throw new LibraryImportError(
      `the library file for "${sound.packId}/${sound.name}" is missing (${sound.file}); reinstall the pack`,
    )
  }
  if (!info.isFile() || info.size === 0) {
    throw new LibraryImportError(`the library file for "${sound.packId}/${sound.name}" is empty or not a file`)
  }

  const ffmpeg = findFfmpeg?.() ?? null
  if (!ffmpeg) {
    throw new LibraryImportError(
      'ffmpeg not found; placing a library sound needs it to convert the pack file to 48 kHz stereo WAV '
      + '(set ANYAUDIO_FFMPEG or add ffmpeg to PATH)',
    )
  }

  const dir = projectDir(workspaceRoot, projectId)
  const id = newMaterialId()
  const materialCopy = resolveInside(dir, `${MATERIALS_DIR}/${id}.wav`)
  await mkdir(resolveInside(dir, MATERIALS_DIR), { recursive: true })

  await run(ffmpeg.command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', sourcePath,
    '-vn',
    '-ac', String(IMPORT_CHANNELS),
    '-ar', String(IMPORT_SAMPLE_RATE),
    '-c:a', 'pcm_s16le',
    materialCopy,
  ], { signal })

  let decoded
  try {
    const wav = parseWav(await readFile(materialCopy))
    const channels = conformChannels(wav.channels, IMPORT_CHANNELS)
    decoded = { channels, durationSec: channels[0].length / wav.sampleRate }
  } catch (error) {
    throw new LibraryImportError(`the converted copy of "${sound.name}" is not a readable WAV: ${error.message}`)
  }

  const analysis = analyzeChannels(decoded.channels, decoded.durationSec)
  const peaksRel = `${MATERIALS_DIR}/${id}.peaks.json`
  await writePeaks(resolveInside(dir, peaksRel), analysis.peaks)

  const material = await registerMaterial(workspaceRoot, projectId, {
    id,
    file: `${MATERIALS_DIR}/${id}.wav`,
    durationSec: decoded.durationSec,
    sampleRate: IMPORT_SAMPLE_RATE,
    channels: IMPORT_CHANNELS,
    kind: 'library',
    bytes: info.size,
    peakDb: analysis.peakDb,
    rmsDb: analysis.rmsDb,
    source: {
      kind: 'library',
      packId: sound.packId,
      soundName: sound.name,
      type: sound.type,
      file: sound.file,
      importedAt: nowIso(),
    },
  })
  return { material, reused: false, peaks: peaksRel }
}

/**
 * Convert one downloaded preview into the project and register it.
 *
 * The online source is the second of three, so its provenance has to say where
 * the file came from: a person reading the index a month later must be able to
 * find the original page and its licence without guessing.
 */
export async function importRemoteMaterial(workspaceRoot, projectId, { sound, previewPath, findFfmpeg, signal }) {
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const existing = (index?.materials ?? []).find(
    (entry) => entry.source?.kind === 'remote' && entry.source.soundId === Number(sound.soundId),
  )
  if (existing) return { material: existing, reused: true }

  const ffmpeg = findFfmpeg?.() ?? null
  if (!ffmpeg) {
    throw new LibraryImportError(
      'ffmpeg not found; placing an online sound needs it to convert the preview to 48 kHz stereo WAV '
      + '(set ANYAUDIO_FFMPEG or add ffmpeg to PATH)',
    )
  }

  const dir = projectDir(workspaceRoot, projectId)
  const id = newMaterialId()
  const materialCopy = resolveInside(dir, `${MATERIALS_DIR}/${id}.wav`)
  await mkdir(resolveInside(dir, MATERIALS_DIR), { recursive: true })

  await run(ffmpeg.command, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', previewPath,
    '-vn',
    '-ac', String(IMPORT_CHANNELS),
    '-ar', String(IMPORT_SAMPLE_RATE),
    '-c:a', 'pcm_s16le',
    materialCopy,
  ], { signal })

  let decoded
  try {
    const wav = parseWav(await readFile(materialCopy))
    const channels = conformChannels(wav.channels, IMPORT_CHANNELS)
    decoded = { channels, durationSec: channels[0].length / wav.sampleRate }
  } catch (error) {
    throw new LibraryImportError(`the converted copy of the online sound is not a readable WAV: ${error.message}`)
  }

  const analysis = analyzeChannels(decoded.channels, decoded.durationSec)
  const peaksRel = `${MATERIALS_DIR}/${id}.peaks.json`
  await writePeaks(resolveInside(dir, peaksRel), analysis.peaks)

  const material = await registerMaterial(workspaceRoot, projectId, {
    id,
    file: `${MATERIALS_DIR}/${id}.wav`,
    durationSec: decoded.durationSec,
    sampleRate: IMPORT_SAMPLE_RATE,
    channels: IMPORT_CHANNELS,
    kind: 'library',
    peakDb: analysis.peakDb,
    rmsDb: analysis.rmsDb,
    source: remoteSource(sound),
  })
  return { material, reused: false, peaks: peaksRel }
}

export { probeMediaDuration, basename }
