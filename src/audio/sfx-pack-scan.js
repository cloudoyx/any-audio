/**
 * Build a manifest for a folder that does not have one.
 *
 * The install route used to require a manifest, which meant a person had to run
 * a Node script first — a developer step in a settings page. This is the other
 * half: point it at a folder of audio and it works out what is in there.
 *
 * Only the duration is measured. `peakPosSec` is optional in the manifest and
 * needs a full decode per file; leaving it out costs the waveform's peak marker
 * and nothing else, which is the right trade for an install that has to finish.
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { findFfmpeg } from '../tools/shared.js'
import { probeDuration } from './mux.js'
import { SFX_MANIFEST_SCHEMA_VERSION, normalizeManifest, validateSoundName } from './sfx-manifest.js'

/** The three subdirectories a pack may use, and the type each one means. */
export const PACK_TYPE_DIRS = { FOL: 'foley', AMB: 'ambience', DSN: 'dsn' }

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.webm'])

function isAudio(name) {
  return AUDIO_EXTENSIONS.has(extname(name).toLowerCase())
}

async function listAudio(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && isAudio(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Scan `dir` and return `{ manifest, warnings }`.
 *
 * `FOL/` `AMB/` `DSN/` are used when present. A folder with none of them is not
 * rejected: every loose audio file becomes a foley sound, because "drop a folder
 * in" is the whole point and refusing it would send the person back to a script.
 */
export async function scanPackFolder(dir, { packId, signal, onProgress } = {}) {
  const id = packId ?? basename(dir)
  const warnings = []
  const groups = []

  for (const [dirName, type] of Object.entries(PACK_TYPE_DIRS)) {
    const full = join(dir, dirName)
    const info = await stat(full).catch(() => null)
    if (!info?.isDirectory()) continue
    const files = await listAudio(full)
    if (files.length) groups.push({ dirName, type, files })
  }

  if (groups.length === 0) {
    const files = await listAudio(dir)
    if (files.length === 0) {
      throw new Error(`no audio files in "${dir}"; put them in FOL/, AMB/ or DSN/, or directly in the folder`)
    }
    groups.push({ dirName: '', type: 'foley', files })
    warnings.push('no FOL/ AMB/ DSN/ subfolder, so every file was treated as a foley sound')
  }

  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error('ffmpeg not found; reading the duration of each file needs it (set ANYAUDIO_FFMPEG or add ffmpeg to PATH)')

  const total = groups.reduce((sum, group) => sum + group.files.length, 0)
  const sounds = []
  const seen = new Set()
  let done = 0

  for (const group of groups) {
    for (const file of group.files) {
      if (signal?.aborted) throw new Error('cancelled')
      const name = basename(file, extname(file))
      const label = group.dirName ? `${group.dirName}/${file}` : file
      done++
      onProgress?.(done, total)

      try {
        validateSoundName(name)
      } catch (error) {
        warnings.push(`${label}: ${error.message}; skipped`)
        continue
      }
      if (seen.has(name)) {
        warnings.push(`${label}: another sound is already called "${name}"; skipped`)
        continue
      }

      const durationSec = await probeDuration(ffmpeg.command, join(dir, group.dirName, file), { signal })
      if (!durationSec) {
        warnings.push(`${label}: could not read its duration; skipped`)
        continue
      }

      seen.add(name)
      sounds.push({
        name,
        type: group.type,
        durationSec: Number(durationSec.toFixed(3)),
        file: group.dirName ? `${group.dirName}/${file}` : file,
      })
    }
  }

  if (sounds.length === 0) throw new Error(`no usable audio in "${dir}"; see the warnings for why each file was skipped`)

  const raw = {
    schemaVersion: SFX_MANIFEST_SCHEMA_VERSION,
    id,
    name: id,
    version: '1.0.0',
    license: '',
    format: extname(sounds[0].file).replace('.', '').toLowerCase(),
    sounds,
  }
  const normalized = normalizeManifest(raw, { packId: id })
  return { manifest: normalized.manifest, warnings: [...warnings, ...normalized.warnings] }
}
