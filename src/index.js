import { readFile } from 'node:fs/promises'
import { registerAnyAudioRoutes } from './host/routes.js'
import { registerAllTools } from './tools/index.js'
import { setCredentialResolver } from './tools/tts.js'
import { setWorkingDirectoryService } from './tools/shared.js'

export const name = 'any-audio'
export const inject = ['tools']

const SKILL_NAME = 'anyaudio-scoring'
const SKILL_SOURCE = 'any-audio'
const SKILL_DESCRIPTION =
  'Score and mix music for videos: SoundFont instrument rendering from note-level scores, optional arrangement techniques, procedural sound effects, narration ducking and timeline mixing.'
const SKILL_WHEN_TO_USE =
  'When a task creates or edits a video that needs music, narration or sound effects, or an existing video needs better audio.'

const PROMPT_SECTION = `Video audio: this harness can render real instrumental music and mix it into videos with the anyaudio_* tools.
- Proactive default: when a request creates or edits a video (animation, explainer, promo, science, concept, interactive clip), treat the audio as part of the deliverable even if the user did not mention it — plan music, add the sound effects the pictures need, synthesise narration when the video needs a voice, and finish with a mix. Do not deliver a silent video unless the user explicitly wants silence or already supplied finished audio.
- anyaudio_sources — inspect/install the sound sources (SoundFont banks today; sample packs and voices later). Run "install" once if no instrument bank is present.
- anyaudio_music — note-level score (seconds on the video timeline) → WAV with real instruments. Prefer this over hand-written numpy/DSP synthesis for music. Tracks may each use a different bank via "source"; "auto" picks the best-scored installed bank.
- anyaudio_tts — narration from text. It uses the engine and voice the user configured in Settings → AnyAudio (Edge by default, or MiMo-V2.5-TTS when selected). Always use this tool for narration in a video: do not run edge-tts, ttsmaker or any other Python/node TTS library yourself, because that bypasses the user's engine and voice choice.
- anyaudio_sfx — sound effects on a timeline. It plays real presets from the two default banks (birds, seashore, rain, thunder, wind, stream, dog, footsteps, door, telephone, car, siren, train, helicopter, applause, laughter, scream, gun shot, explosion, heartbeat …) via {preset:"rain"}; run it with action:"catalog" to list them with shape and level notes. It also has 15 procedural generators (wind, footsteps, impacts, risers, drums) for sounds no preset covers.
- anyaudio_mix — place narration/music/sfx on one timeline, duck the bed under narration, fade in/out, normalise the master, and optionally mux the finished MP4 (video stream copied). It balances the three buses; balancing tracks inside the music is anyaudio_music's job (gainDb per track).
Drum kits always come from the default bank; a score can mix banks for melodic tracks but not for drums.
The user can change default TTS voice, music peak, ducking and output folder in Settings → AnyAudio; tool arguments always override those defaults. Relative output paths always resolve against the project the user is working in (<project>/.anyaudio/out by default), never against the harness install folder.
Load the "anyaudio-scoring" skill for the score format, instrument names and mixing workflow. When a request produces or edits a video, derive timings from the storyboard/narration/timing files that already exist, keep the audio exactly as long as the picture, verify the returned duration and peak level, and never overwrite the source video.`

function safeGet(ctx, service) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(service) : undefined
  } catch {
    return undefined
  }
}

async function installSkill(ctx, log) {
  const skills = safeGet(ctx, 'skills')
  if (!skills || typeof skills.register !== 'function') {
    log('skills service unavailable; the anyaudio-scoring skill was not registered')
    return
  }
  try {
    const content = await readFile(new URL('./skills/anyaudio-scoring.md', import.meta.url), 'utf8')
    skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      source: SKILL_SOURCE,
      content,
      provider: 'any-audio',
    })
    log(`registered skill "${SKILL_NAME}"`)
  } catch (error) {
    log(`skill registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function installPromptSection(ctx, log) {
  const systemPrompt = safeGet(ctx, 'systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    log('systemPrompt service unavailable; the video audio hint was not added')
    return
  }
  try {
    systemPrompt.section({ name: 'any-audio', order: 2050, text: PROMPT_SECTION })
    log('added video audio hint to the system prompt')
  } catch (error) {
    log(`system prompt section failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx, config = {}) {
  const options = { tools: true, skill: true, prompt: true, routes: true, ...config }
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[any-audio] ${message}`)
    } catch {
      // logging must never break plugin loading
    }
  }

  try {
    setWorkingDirectoryService(safeGet(ctx, 'workingDirectory'))
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['workingDirectory'], (sctx) => setWorkingDirectoryService(sctx.workingDirectory))
      } catch {
        // the direct lookup above stays as the fallback
      }
    }
    if (options.tools) log(`registered tools: ${registerAllTools(ctx, log)}`)
    if (options.skill) void installSkill(ctx, log)
    if (options.prompt) installPromptSection(ctx, log)
    if (options.routes) {
      try {
        if (typeof ctx.inject === 'function') {
          try {
            ctx.inject(['webServer'], (sctx) => registerAnyAudioRoutes(sctx, { log }))
            log('settings bridge waits for the web server')
          } catch {
            const { dispose } = registerAnyAudioRoutes(ctx, { log })
            if (typeof ctx.effect === 'function' && typeof dispose === 'function') ctx.effect(() => dispose, 'any-audio: settings routes')
          }
        } else {
          const { dispose } = registerAnyAudioRoutes(ctx, { log })
          if (typeof ctx.effect === 'function' && typeof dispose === 'function') ctx.effect(() => dispose, 'any-audio: settings routes')
        }
        setCredentialResolver(async (ref) => {
          const credentials = safeGet(ctx, 'credentials')
          if (!credentials?.resolve) return null
          return credentials.resolve(ref)
        })
      } catch (error) {
        log(`settings bridge failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } catch (error) {
    log(`plugin setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export { SKILL_DESCRIPTION, SKILL_NAME }
