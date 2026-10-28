import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { applyCurve, applyFades, applyGainDb, buildDuckCurve, buildEnvelope, fitFrames, maskedRms, normalizePeak, sumTracks } from '../audio/mix.js'
import { conformChannels, parseWav, peakOf, resample, rmsOf, toDb } from '../audio/wav.js'
import { finalizeTool, findFfmpeg, nowStamp, relativeToWorkspace, resolveOutputPath, runFfmpeg, seconds as clampSeconds, textRenderer, workspaceRootOf, writeWavFile } from './shared.js'
import { readConfig } from '../config.js'

function parseJsonMaybe(value, label) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    throw new Error(`${label} must be a JSON object or boolean`)
  }
}

function applyPan(channels, pan) {
  const amount = Math.max(-1, Math.min(1, Number(pan) || 0))
  if (amount === 0) return channels
  const angle = ((amount + 1) * Math.PI) / 4
  const leftGain = Math.cos(angle)
  const rightGain = Math.sin(angle)
  const left = new Float32Array(channels[0].length)
  const right = new Float32Array(channels[0].length)
  for (let i = 0; i < left.length; i++) {
    left[i] = channels[0][i] * leftGain
    right[i] = channels[1][i] * rightGain
  }
  return [left, right]
}

async function loadTrack(path, sampleRate) {
  const buffer = await readFile(path)
  const wav = parseWav(buffer)
  let channels = conformChannels(wav.channels, 2)
  if (wav.sampleRate !== sampleRate) channels = resample(channels, wav.sampleRate, sampleRate)
  return { channels, sourceDurationSec: wav.durationSec, sourceSampleRate: wav.sampleRate }
}

function placeInto(source, { sampleRate, frames, offsetSec, loop }) {
  const out = [new Float32Array(frames), new Float32Array(frames)]
  const offset = Math.round(Math.max(0, offsetSec) * sampleRate)
  const sourceFrames = source[0].length
  if (sourceFrames === 0) return out
  const repeats = loop ? Math.ceil((frames + sourceFrames) / sourceFrames) + 1 : 1
  for (let ch = 0; ch < 2; ch++) {
    for (let copy = 0; copy < repeats; copy++) {
      const base = offset + copy * sourceFrames
      if (base >= frames) break
      for (let i = 0; i < sourceFrames; i++) {
        const target = base + i
        if (target >= frames) break
        out[ch][target] += source[ch][i]
      }
    }
  }
  return out
}

async function extractNarration(videoPath, workspaceRoot) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new Error('ffmpeg not found; cannot extract the narration track from the video (set ANYAUDIO_FFMPEG or add ffmpeg to PATH)')
  const target = join(workspaceRoot, '.anyaudio', 'in', `${basename(videoPath, extname(videoPath))}-audio.wav`)
  await mkdir(dirname(target), { recursive: true })
  await runFfmpeg(ffmpeg.command, ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', target])
  return target
}

/** Read a media file's duration from ffmpeg's banner (no ffprobe dependency). */
function probeDuration(command, file) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, ['-hide_banner', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal: AbortSignal.timeout(15000) })
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

async function muxVideo(videoPath, audioPath, outputPath, { audioDurationSec, videoDurationSec: probed } = {}) {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return { ok: false, error: 'ffmpeg not found; the WAV is ready, mux it manually with ffmpeg or set ANYAUDIO_FFMPEG' }
  await mkdir(dirname(outputPath), { recursive: true })
  const videoDurationSec = Number.isFinite(Number(probed)) && Number(probed) > 0 ? Number(probed) : await probeDuration(ffmpeg.command, videoPath)
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
    await runFfmpeg(ffmpeg.command, args)
  } catch (error) {
    return { ok: false, file: outputPath, error: error.message, warnings }
  }
  const writtenDurationSec = await probeDuration(ffmpeg.command, outputPath)
  if (videoDurationSec && writtenDurationSec && Math.abs(writtenDurationSec - videoDurationSec) > 0.1) {
    warnings.push(`the muxed video is ${writtenDurationSec.toFixed(2)}s but the source video is ${videoDurationSec.toFixed(2)}s`)
  }
  return { ok: true, file: outputPath, videoDurationSec: videoDurationSec ?? null, durationSec: writtenDurationSec ?? null, warnings }
}

export const mixToolDefinition = finalizeTool({
  name: 'anyaudio_mix',
  description:
    'Mix audio tracks onto one timeline and write a final WAV (optionally muxing it into a video with ffmpeg). ' +
    'Finish every video deliverable with this tool: even a short clip sounds unfinished without a mix of music, effects and voice. ' +
    'Tracks are placed in order with per-track gain, pan, fades and looping; any track with role "narration" automatically lowers the level of all other tracks while the voice is present (ducking), which keeps dialogue intelligible. ' +
    'It balances the narration / music / sfx buses against each other; the balance between instruments inside the music is anyaudio_music\'s job (per-track gainDb), so fix a buried instrument there instead of pulling the whole music bus up. ' +
    'Always pass durationSec = the video length so audio and picture end together. ' +
    'Pass video + videoOutput to produce the finished MP4 (video stream copied, audio encoded to AAC 192k). The output keeps the video\'s own length: a shorter mix is padded with silence and a longer one is cut at the last frame of the picture. Set videoAudio:"narration" to reuse the audio already inside the video as the narration track.',
  parameters: {
    type: 'object',
    properties: {
      tracks: {
        type: 'array',
        description: 'Audio sources: [{role:"narration"|"music"|"sfx"|"ambience", path, gainDb, pan, fadeInSec, fadeOutSec, offsetSec, loop, duck}].',
        items: { type: 'object', additionalProperties: true },
      },
      output: { type: 'string', description: "Output WAV path. Relative paths resolve against the user's project; defaults to <project>/.anyaudio/out/mix-<timestamp>.wav." },
      durationSec: { type: 'number', description: 'Exact timeline length in seconds (use the video duration). Defaults to the longest placed track.' },
      sampleRate: { type: 'number', description: 'Sample rate, default 48000. Tracks are resampled to it.' },
      masterPeakDb: { type: 'number', description: 'Final peak ceiling in dBFS, default -1.5. null disables normalisation.' },
      ducking: {
        type: 'object',
        description: 'Ducking settings: {enabled, targetDb:-9, thresholdDb:-42, attackSec:0.12, releaseSec:0.4}. Pass false to disable.',
      },
      video: { type: 'string', description: 'Optional source video to mux the mix into.' },
      videoOutput: { type: 'string', description: 'Output video path when video is given; defaults next to the WAV.' },
      videoAudio: { type: 'string', description: 'When video is given: "narration" extracts its audio and duck the music against it; default "skip".' },
    },
    required: ['tracks'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        peakDb: { type: 'number' },
        rmsDb: { type: 'number' },
        tracks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        ducking: { type: 'object', additionalProperties: true },
        mux: { type: 'object', additionalProperties: true },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((_args, value) => {
      const lines = [
        `Mixed ${value.durationSec.toFixed(2)}s → ${value.file}`,
        `peak ${value.peakDb.toFixed(1)} dBFS, RMS ${value.rmsDb.toFixed(1)} dBFS`,
        'Tracks:',
        ...value.tracks.map((track) => `- ${track.role}: ${track.file}${track.loop ? ' (looped)' : ''}, gain ${track.gainDb.toFixed(1)} dB${track.ducked ? ', ducked' : ''}`),
      ]
      if (value.ducking?.enabled) {
        lines.push(`Ducking active: ${(value.ducking.activeRatio * 100).toFixed(0)}% of the timeline is under narration, bed down up to ${Math.abs(value.ducking.targetDb).toFixed(0)} dB, measured bed drop ${value.ducking.measuredDropDb.toFixed(1)} dB`)
      }
      if (value.mux) lines.push(value.mux.ok ? `Video written: ${value.mux.file}` : `Video mux failed: ${value.mux.error}`)
      if (value.warnings?.length) lines.push(...value.warnings.map((warning) => `Warning: ${warning}`))
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const { config } = await readConfig()
    let trackSpecs = Array.isArray(args.tracks) ? args.tracks : parseJsonMaybe(args.tracks, 'tracks')
    if (!Array.isArray(trackSpecs) || trackSpecs.length === 0) throw new Error('tracks must be a non-empty array')
    trackSpecs = trackSpecs.map((spec) => ({ ...spec, role: spec.role ?? 'music' }))

    const sampleRate = Math.round(clampSeconds(args.sampleRate ?? config.mix.sampleRate, config.mix.sampleRate)) || config.mix.sampleRate
    const warnings = []

    if (args.video && String(args.videoAudio ?? '').toLowerCase() === 'narration' && !trackSpecs.some((spec) => spec.role === 'narration')) {
      if (!workspaceRoot) throw new Error('cannot extract narration without a workspace folder; pass the narration WAV as a track with an absolute path')
      const extracted = await extractNarration(String(args.video), workspaceRoot)
      trackSpecs.unshift({ role: 'narration', path: extracted, source: 'video' })
    }

    const resolveInput = (value) => {
      if (isAbsolute(String(value))) return String(value)
      if (!workspaceRoot) throw new Error(`cannot resolve relative track path "${value}" without a workspace folder; pass an absolute path`)
      return resolve(workspaceRoot, String(value))
    }

    const loaded = []
    for (const [index, spec] of trackSpecs.entries()) {
      if (!spec.path) throw new Error(`track #${index} (${spec.role}) needs a "path" to a WAV file`)
      const path = resolveInput(spec.path)
      const loadedTrack = await loadTrack(path, sampleRate)
      loaded.push({ spec, ...loadedTrack, path })
    }

    const longest = loaded.reduce((max, track) => {
      const offset = Number(track.spec.offsetSec) || 0
      return Math.max(max, offset + track.sourceDurationSec)
    }, 0)
    let videoPath = null
    if (args.video) videoPath = resolveInput(args.video)
    if (!args.durationSec && loaded.some((track) => track.spec.loop === true)) {
      warnings.push('looped tracks without durationSec are cut to their single-pass length; pass the video length to fill the whole timeline')
    }
    const frames = Math.max(1, Math.round((clampSeconds(args.durationSec, longest || 1) || 1) * sampleRate))
    if (!args.durationSec) warnings.push('durationSec was not given, so the mix length follows the longest track — pass the video length to guarantee frame-accurate alignment')

    const placed = loaded.map((track) => {
      const offsetSec = Number(track.spec.offsetSec) || 0
      let channels = placeInto(track.channels, { sampleRate, frames, offsetSec, loop: track.spec.loop === true })
      channels = fitFrames(channels, frames)
      channels = applyGainDb(channels, Number(track.spec.gainDb) || 0)
      if (track.spec.pan !== undefined) channels = applyPan(channels, track.spec.pan)
      const fadeInSec = Number(track.spec.fadeInSec) || 0
      const fadeOutSec = Number(track.spec.fadeOutSec) || 0
      if (fadeInSec > 0 || fadeOutSec > 0) channels = applyFades(channels, sampleRate, fadeInSec, fadeOutSec)
      return { ...track, channels }
    })

    const parsedDuck = args.ducking === undefined ? undefined : parseJsonMaybe(args.ducking, 'ducking')
    const duckSettings = {
      ...config.mix.ducking,
      ...(parsedDuck && typeof parsedDuck === 'object' ? parsedDuck : {}),
      enabled: parsedDuck === false ? false : parsedDuck?.enabled ?? config.mix.ducking.enabled,
    }
    const narration = placed.filter((track) => track.spec.role === 'narration')
    const bedTracks = placed.filter((track) => track.spec.role !== 'narration')
    let ducking = { enabled: false }
    if (duckSettings.enabled && narration.length > 0 && bedTracks.length === 0) {
      warnings.push('ducking skipped: every track is narration, so there is no background bed to duck')
    } else if (duckSettings.enabled && narration.length > 0) {
      const narrationSum = sumTracks(narration.map((track) => track.channels))
      const env = buildEnvelope(narrationSum, sampleRate)
      const curve = buildDuckCurve(env, sampleRate, {
        targetDb: duckSettings.targetDb ?? -9,
        thresholdDb: duckSettings.thresholdDb ?? -42,
        attackSec: duckSettings.attackSec ?? 0.12,
        releaseSec: duckSettings.releaseSec ?? 0.4,
      })
      let active = 0
      for (let i = 0; i < frames; i++) if (env[i] > Math.pow(10, (duckSettings.thresholdDb ?? -42) / 20)) active++
      const bedBefore = sumTracks(bedTracks.map((track) => track.channels))
      const bedAfterParts = []
      for (const track of placed) {
        if (track.spec.role === 'narration' || track.spec.duck === false) continue
        track.channels = applyCurve(track.channels, curve)
        track.ducked = true
        bedAfterParts.push(track.channels)
      }
      const bedAfter = bedAfterParts.length ? sumTracks(bedAfterParts) : [new Float32Array(frames), new Float32Array(frames)]
      const mask = new Uint8Array(frames)
      for (let i = 0; i < frames; i++) mask[i] = env[i] > Math.pow(10, (duckSettings.thresholdDb ?? -42) / 20) ? 1 : 0
      const beforeRms = maskedRms(bedBefore, mask)
      const afterRms = maskedRms(bedAfter, mask)
      ducking = {
        enabled: true,
        activeRatio: frames ? active / frames : 0,
        targetDb: duckSettings.targetDb ?? -9,
        measuredDropDb: beforeRms > 0 && afterRms > 0 ? Number(toDb(afterRms / beforeRms).toFixed(2)) : 0,
        narrationRmsDb: Number(toDb(rmsOf(narrationSum)).toFixed(2)),
      }
    } else if (duckSettings.enabled) {
      warnings.push('ducking requested but no track has role "narration"; nothing was ducked')
    }

    let mixed = sumTracks(placed.map((track) => track.channels))
    const masterPeakDb = args.masterPeakDb === undefined ? config.mix.masterPeakDb : args.masterPeakDb
    if (masterPeakDb !== null) {
      const normalized = normalizePeak(mixed, Number.isFinite(Number(masterPeakDb)) ? Number(masterPeakDb) : config.mix.masterPeakDb)
      mixed = normalized.channels
      ducking.masterGainDb = Number(normalized.gainDb.toFixed(2))
    }

    const target = resolveOutputPath({ workspaceRoot, outputDir: config.output.dir, requested: args.output, defaultName: `mix-${nowStamp()}.wav` })
    const written = await writeWavFile(target, mixed, sampleRate)

    let mux
    if (args.video) {
      const videoOut = args.videoOutput ? resolveInput(args.videoOutput) : target.replace(/\.wav$/i, '.mp4')
      mux = await muxVideo(videoPath, written.path, videoOut, { audioDurationSec: frames / sampleRate })
      if (Array.isArray(mux.warnings)) warnings.push(...mux.warnings)
      if (mux.ok) mux.file = relativeToWorkspace(workspaceRoot, mux.file)
    }

    return {
      ok: !mux || mux.ok !== false,
      file: relativeToWorkspace(workspaceRoot, written.path),
      absolutePath: written.path,
      bytes: written.bytes,
      durationSec: Number((frames / sampleRate).toFixed(3)),
      sampleRate,
      peakDb: Number(toDb(peakOf(mixed)).toFixed(2)),
      rmsDb: Number(toDb(rmsOf(mixed)).toFixed(2)),
      tracks: placed.map((track) => ({
        role: track.spec.role,
        file: relativeToWorkspace(workspaceRoot, track.path),
        source: track.spec.source ?? 'file',
        gainDb: Number(track.spec.gainDb) || 0,
        rmsDb: Number(toDb(rmsOf(track.channels)).toFixed(1)),
        offsetSec: Number(track.spec.offsetSec) || 0,
        fadeInSec: Number(track.spec.fadeInSec) || 0,
        fadeOutSec: Number(track.spec.fadeOutSec) || 0,
        loop: track.spec.loop === true,
        ducked: track.ducked === true,
      })),
      ducking,
      mux,
      warnings,
    }
  },
})

export function registerMixTool(ctx) {
  ctx.tools.register(mixToolDefinition)
}

