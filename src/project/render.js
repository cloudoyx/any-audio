/**
 * Project renderer: project.json in, audio out (spec §4 layer ③, plan M3).
 *
 * Two rules shape everything here:
 *  - render is a pure function of the project file, so it can run without any UI;
 *  - export gain is `normalizeGainDb + masterFaderDb` and is never re-normalised
 *    (spec §10.2), or a move of the master fader would silently be undone on export.
 *
 * Tracks are streamed one at a time and summed in place into a single
 * accumulator; a full-length buffer per track would be 20 allocations of the
 * whole timeline (plan M3).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { accumulateInto, applyFades, applyGainDb, panGains } from '../audio/mix.js'
import { conformChannels, encodeWav, fromDb, parseWav, peakOf, resample, rmsOf, toDb } from '../audio/wav.js'
import { findFfmpeg, runFfmpeg } from '../tools/shared.js'
import { muxVideo, probeDuration } from '../tools/mix.js'
import { contentEndSec, validateProject } from './schema.js'
import { projectDir, resolveInside } from './paths.js'
import { findMaterial } from './materials.js'
import { readMaterialIndex } from './store.js'

export class RenderError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RenderError'
  }
}

function cancelledError() {
  const error = new Error('the render was cancelled')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError()
}

/** Solo is exclusive: as soon as one track is soloed, every other track is silent. */
function audibleTracks(project) {
  if (!project.tracks.some((track) => track.solo)) return project.tracks
  return project.tracks.filter((track) => track.solo)
}

async function loadMaterial(sampleRate, path) {
  const wav = parseWav(await readFile(path))
  let channels = conformChannels(wav.channels, 2)
  if (wav.sampleRate !== sampleRate) channels = resample(channels, wav.sampleRate, sampleRate)
  return channels
}

/**
 * Slice one clip's source range out of its material (inSec/outSec, spec §6.2).
 * A range running past the end of the file yields silence for the remainder
 * instead of throwing: the project says where the clip ends, the file says where
 * the audio ends, and the shorter one wins.
 */
function sliceItem(channels, sampleRate, item) {
  const start = Math.max(0, Math.round(item.inSec * sampleRate))
  const length = Math.max(0, Math.round((item.outSec - item.inSec) * sampleRate))
  const take = Math.min(length, Math.max(0, channels[0].length - start))
  const out = [new Float32Array(length), new Float32Array(length)]
  if (take <= 0) return out
  out[0].set(channels[0].subarray(start, start + take))
  out[1].set(channels[1].subarray(start, start + take))
  return out
}

/** Render a validated project to float channels. */
export async function renderProject({ project, workspaceRoot, signal, onProgress } = {}) {
  validateProject(project)
  const sampleRate = project.sampleRate
  const projectId = project.id
  const dir = projectDir(workspaceRoot, projectId)
  const index = await readMaterialIndex(workspaceRoot, projectId)
  const durationSec = contentEndSec(project)
  if (!(durationSec > 0)) throw new RenderError('this project is empty: add at least one clip before rendering')
  const frames = Math.round(durationSec * sampleRate)

  const acc = [new Float32Array(frames), new Float32Array(frames)]
  const tracks = audibleTracks(project)
  const reports = []
  const materialCache = new Map()
  let clipCount = 0

  for (const [trackIndex, track] of tracks.entries()) {
    throwIfAborted(signal)
    const silent = track.muted === true
    const trackGain = silent ? 0 : fromDb(Number(track.volumeDb) || 0)
    const report = {
      id: track.id,
      name: track.name,
      category: track.category,
      volumeDb: Number(track.volumeDb) || 0,
      pan: Number(track.pan) || 0,
      muted: silent,
      clips: 0,
    }
    for (const item of track.items) {
      throwIfAborted(signal)
      if (item.muted) continue
      const entry = findMaterial(index, item.material)
      if (!entry) {
        throw new RenderError(`clip "${item.label || item.id}" refers to material "${item.material}", which is not in the project index`)
      }
      if (!materialCache.has(item.material)) {
        const path = resolveInside(dir, entry.file, `material "${item.material}"`)
        materialCache.set(item.material, await loadMaterial(sampleRate, path))
      }
      let piece = sliceItem(materialCache.get(item.material), sampleRate, item)
      const itemGainDb = Number(item.gainDb) || 0
      if (itemGainDb) piece = applyGainDb(piece, itemGainDb)
      const fadeInSec = Number(item.fadeInSec) || 0
      const fadeOutSec = Number(item.fadeOutSec) || 0
      if (fadeInSec > 0 || fadeOutSec > 0) piece = applyFades(piece, sampleRate, fadeInSec, fadeOutSec)
      // Clip pan and track pan add up, then one equal-power pair is applied once.
      const pan = Math.max(-1, Math.min(1, (Number(item.pan) || 0) + (Number(track.pan) || 0)))
      const [panLeft, panRight] = panGains(pan)
      accumulateInto(acc, piece, Math.round(item.startSec * sampleRate), trackGain * panLeft, trackGain * panRight)
      report.clips++
      clipCount++
      onProgress?.({ phase: 'render', track: trackIndex + 1, tracks: tracks.length, clips: clipCount })
    }
    reports.push(report)
  }

  throwIfAborted(signal)
  if (clipCount === 0) throw new RenderError('this project has no audible clips to render')

  // Export gain is the sum of the fixed normalisation and the user's fader,
  // applied once and never measured back (spec §10.2).
  const appliedGainDb = (Number(project.normalizeGainDb) || 0) + (Number(project.masterFaderDb) || 0)
  const peakBeforeGainDb = Number(toDb(peakOf(acc)).toFixed(2))
  if (appliedGainDb) {
    const gain = fromDb(appliedGainDb)
    for (let channel = 0; channel < 2; channel++) {
      const samples = acc[channel]
      for (let i = 0; i < samples.length; i++) samples[i] *= gain
    }
  }

  onProgress?.({ phase: 'render', done: true, clips: clipCount })

  return {
    channels: acc,
    sampleRate,
    frames,
    durationSec: Number((frames / sampleRate).toFixed(6)),
    clipCount,
    trackCount: tracks.length,
    appliedGainDb: Number(appliedGainDb.toFixed(2)),
    peakBeforeGainDb,
    peakDb: Number(toDb(peakOf(acc)).toFixed(2)),
    rmsDb: Number(toDb(rmsOf(acc)).toFixed(2)),
    tracks: reports,
  }
}

/** Write rendered channels to a WAV file; a failure leaves no partial file behind. */
export async function writeRenderWav(rendered, outputPath, { signal } = {}) {
  throwIfAborted(signal)
  await mkdir(dirname(outputPath), { recursive: true })
  try {
    await writeFile(outputPath, encodeWav({ sampleRate: rendered.sampleRate, channels: rendered.channels, bitDepth: 16 }))
  } catch (error) {
    await rm(outputPath, { force: true })
    throw error
  }
  return outputPath
}

/** Encode a WAV to MP3; a cancelled or failed encode leaves no partial file behind. */
export async function transcodeMp3(wavPath, mp3Path, { signal } = {}) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new RenderError('ffmpeg not found; cannot write MP3 (set ANYAUDIO_FFMPEG or add ffmpeg to PATH)')
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-c:a', 'libmp3lame', '-b:a', '192k', mp3Path]
  try {
    await runFfmpeg(ffmpeg.command, args, { signal })
  } catch (error) {
    await rm(mp3Path, { force: true })
    if (error?.name === 'AbortError') throw cancelledError()
    throw error
  }
  return mp3Path
}

/**
 * Full export: render, then write WAV, MP3 or MP4.
 *
 * For MP4 the picture is copied and the render replaces its audio, keeping the
 * video's own length even when the project is shorter (plan M3). A cancellation
 * removes every partial file, including the intermediate WAV.
 */
export async function exportProject({ project, workspaceRoot, outputPath, format = 'wav', signal, onProgress } = {}) {
  const target = String(format).toLowerCase()
  if (!['wav', 'mp3', 'mp4'].includes(target)) {
    throw new RenderError(`unknown export format "${format}"; use wav, mp3 or mp4`)
  }
  if (target === 'mp4' && !project.video?.path) {
    throw new RenderError('this project has no video; export MP4 only for projects with a picture')
  }
  const rendered = await renderProject({ project, workspaceRoot, signal, onProgress })
  const wavPath = target === 'wav' ? outputPath : `${outputPath}.render.wav`
  try {
    await writeRenderWav(rendered, wavPath, { signal })
    onProgress?.({ phase: 'encode', format: target })
    if (target === 'mp3') {
      await transcodeMp3(wavPath, outputPath, { signal })
    } else if (target === 'mp4') {
      const videoPath = resolveInside(projectDir(workspaceRoot, project.id), project.video.path, 'project.video.path')
      const videoDurationSec = Number(project.video.durationSec) || (await probeDuration(findFfmpeg()?.command ?? 'ffmpeg', videoPath, { signal }))
      const muxed = await muxVideo(videoPath, wavPath, outputPath, {
        audioDurationSec: rendered.durationSec,
        videoDurationSec,
        signal,
      })
      throwIfAborted(signal)
      if (!muxed.ok) throw new RenderError(muxed.error ?? 'muxing the video failed')
      onProgress?.({ phase: 'done', format: target })
      return { ...rendered, file: outputPath, format: target, mux: muxed }
    }
    onProgress?.({ phase: 'done', format: target })
    return { ...rendered, file: outputPath, format: target }
  } catch (error) {
    await rm(outputPath, { force: true })
    if (error?.name === 'AbortError') throw cancelledError()
    throw error
  } finally {
    if (wavPath !== outputPath) await rm(wavPath, { force: true })
  }
}

/** Default export file name for a project, used by the tool and the route. */
export function defaultExportName(project, format) {
  return `${project.id}.${format}`
}
