/**
 * Video muxing, shared by the project renderer.
 *
 * These two functions used to live in the mix tool, which made the project
 * renderer depend on a tool file. They are media plumbing, not a tool: the
 * renderer needs them whether or not any tool exposes a "mix" action.
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { findFfmpeg, runFfmpeg } from '../tools/shared.js'

/** Read a media file's duration from ffmpeg's banner (no ffprobe dependency). */
export function probeDuration(command, file, { signal } = {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      const timeout = AbortSignal.timeout(15000)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      child = spawn(command, ['-hide_banner', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: combined })
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
      const secondsValue = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
      resolvePromise(Number.isFinite(secondsValue) && secondsValue > 0 ? secondsValue : null)
    })
  })
}

export async function muxVideo(videoPath, audioPath, outputPath, { audioDurationSec, videoDurationSec: probed, signal } = {}) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not found; the WAV is ready, mux it manually with ffmpeg or set ANYAUDIO_FFMPEG' }
  await mkdir(dirname(outputPath), { recursive: true })
  const videoDurationSec = Number.isFinite(Number(probed)) && Number(probed) > 0 ? Number(probed) : await probeDuration(ffmpeg.command, videoPath, { signal })
  const warnings = []
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  ]
  if (videoDurationSec) {
    // Pad short audio with silence and cut long audio at the picture end: the
    // video stream is copied, so the output must keep the video's own length.
    args.push('-af', 'apad', '-t', String(videoDurationSec))
    const audio = Number(audioDurationSec)
    if (Number.isFinite(audio)) {
      if (audio < videoDurationSec - 0.05) warnings.push(`the mix is ${audio.toFixed(2)}s but the video is ${videoDurationSec.toFixed(2)}s — the tail is filled with silence, the picture is not shortened`)
      else if (audio > videoDurationSec + 0.05) warnings.push(`the mix is ${audio.toFixed(2)}s but the video is ${videoDurationSec.toFixed(2)}s — the extra audio is cut at the end of the picture`)
    }
  } else {
    warnings.push('could not read the video duration; the output keeps the longer of picture and audio instead of the video length')
  }
  args.push('-movflags', '+faststart', outputPath)
  try {
    await runFfmpeg(ffmpeg.command, args, { signal })
  } catch (error) {
    return { ok: false, file: outputPath, error: error.message, warnings }
  }
  const writtenDurationSec = await probeDuration(ffmpeg.command, outputPath, { signal })
  if (videoDurationSec && writtenDurationSec && Math.abs(writtenDurationSec - videoDurationSec) > 0.1) {
    warnings.push(`the muxed video is ${writtenDurationSec.toFixed(2)}s but the source video is ${videoDurationSec.toFixed(2)}s`)
  }
  return { ok: true, file: outputPath, videoDurationSec: videoDurationSec ?? null, durationSec: writtenDurationSec ?? null, warnings }
}
