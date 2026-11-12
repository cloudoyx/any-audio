import { readFile } from 'node:fs/promises'
import { registerAnyAudioRoutes } from './host/routes.js'
import { registerTimelineExpansion } from './host/timeline-ref.js'
import { registerAllTools } from './tools/index.js'
import { setCredentialResolver } from './tools/tts.js'
import { setSfxHostServices } from './tools/sfx.js'
import { setWorkingDirectoryService } from './tools/shared.js'

export const name = 'any-audio'
// Only `tools` is required: a missing attachments or llm service must degrade
// the waveform picture to "no picture", never stop the plugin from loading. Both
// are picked up lazily below, where absence is already handled.
export const inject = ['tools']

const SKILL_NAME = 'anyaudio-scoring'
const SKILL_SOURCE = 'any-audio'
const SKILL_DESCRIPTION =
  'Score and mix music for a clip bay project: SoundFont rendering from note-level scores, arrangement and balance, ducking, and the mixing workflow.'
const SKILL_WHEN_TO_USE =
  'When a task creates or edits a video that needs music, narration or sound effects, or an existing video needs better audio.'

const SKILLS = [
  {
    file: 'anyaudio-scoring.md',
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
  },
  {
    file: 'anyaudio-clipbay.md',
    name: 'anyaudio-clipbay',
    description:
      'Build and edit the clip bay project behind audio a person will listen to and may adjust. Music, narration and effects land in a project automatically, one clip per take, so any line or instrument can be re-heard, moved and re-rendered instead of being baked into one file.',
    whenToUse:
      'Whenever a request produces audio a person will listen to and may adjust — narration, music, effects, or a video soundtrack. Build it as a clip bay project instead of loose files, so the result can be opened, heard and edited. Only skip the project for a single finished file that nobody will adjust afterwards.',
  },
]

// The skill catalog the model sees renders `description` only — `whenToUse` is
// never shown to it (dsh-tool-skill's renderCatalogEntries takes name+description
// alone). So every rule an Agent has to follow has to live in the description,
// in a tool description, or in this section. Writing it anywhere else is dead
// text.
const PROMPT_SECTION = `Video audio: this harness can render real instrumental music and mix it into videos with the anyaudio_* tools.
- Deliver audio as a clip bay project, not as loose files: opening the project is how the person hears the result and adjusts it. The order is fixed — run anyaudio_project mode:"create" first, then pass that projectId to anyaudio_music, anyaudio_tts and anyaudio_sfx, which add what they generate to the project as material and place it on a track. A finished MP4 still comes out of anyaudio_project mode:"render". There is no one-shot mix tool: a file nobody can adjust is not a deliverable.
- Proactive default: when a request creates or edits a video (animation, explainer, promo, science, concept, interactive clip), treat the audio as part of the deliverable even if the user did not mention it — plan music, add the sound effects the pictures need, synthesise narration when the video needs a voice, then render the project. Do not deliver a silent video unless the user explicitly wants silence or already supplied finished audio.
- anyaudio_sources — inspect/install the sound sources (SoundFont banks today; sample packs and voices later). Run "install" once if no instrument bank is present.
- anyaudio_music — note-level score (seconds on the video timeline) → WAV with real instruments, added to the project you name. Prefer this over hand-written numpy/DSP synthesis for music. Tracks may each use a different bank via "source"; "auto" picks the best-scored installed bank.
- anyaudio_tts — narration from text, added to the project you name. The engine and voice come from what the user configured in Settings → AnyAudio; leave provider and voice out unless the person asked for a different engine or voice in this conversation, because passing them overrides that setting. A top-level value applies to every item. Always use this tool for narration in a video: do not run edge-tts, ttsmaker or any other Python/node TTS library yourself, because that bypasses the user's engine and voice choice.
- anyaudio_sfx — sound effects, added to the project you name. Three sources, in this order: ① the installed sound library — {sound:"门-木门-敲门-三下-中等"}; run it with action:"catalog" to list the priority packs' names, action:"search" to find one in the others, action:"inspect" for a sound's fields and a waveform; ② online CC0 — when the library has nothing, action:"search" also looks at Freesound and returns {sound:"freesound/<id>"} plus the previewUrl to pass back; ③ SoundFont presets ({preset:"rain"}) and 15 procedural generators ({type:"wind"}) as the fallback. One name is one recording and may already contain several hits: to make a sound denser or longer, place several clips offset in time — do not look for a "five knocks" entry. You decide how each clip is used (inSec/outSec, fades, gainDb, pan); the tool never splits a recording on its own but does exactly what you ask. Every effect becomes its own clip and is placed on the project timeline as it is created — pass startSec to say where, or omit it and each effect is laid end to end. When you fall back to a synthesised effect, say so in the reply.
- anyaudio_project — the clip bay project file. mode:"create" makes an empty project, "add_material" brings a file the person gave you in and places it on a track, "read" returns the arrangement, "update" edits it by stable ids, "render" mixes it down to WAV/MP3/MP4. Tracks follow what the person will want to move: each instrument stem on its own track, every line of one voice on a single narration track (a second voice is a second track), ambience apart from foley. Never one track per sentence; ≤20 tracks and ≤15 minutes.
Drum kits always come from the default bank; a score can mix banks for melodic tracks but not for drums.
The user can change default TTS voice, music peak, ducking and output folder in Settings → AnyAudio; tool arguments override those defaults only when the person asked for it. Generated audio is always written into the project's own folder first; an "output" argument only adds a delivered copy somewhere else, and the tool reports both paths.
Load the "anyaudio-scoring" skill for the score format, instrument names and mixing workflow, and the "anyaudio-clipbay" skill for how a project is laid out. When a request produces or edits a video, derive timings from the storyboard/narration/timing files that already exist, keep the audio exactly as long as the picture, verify the returned duration and peak level, and never overwrite the source video.
Rules that decide whether the deliverable is worth keeping — these are not stylistic, they change what the person can still edit afterwards:
- A project is the deliverable, not the audio file. It must survive being opened and adjusted.
- One track per thing the person will reach for: each instrument stem apart, every line of one voice together, ambience apart from foley. Never one track per sentence, and never one track for everything.
- Read a project (mode:"read") before changing it, and touch only the range that was asked about. There is no undo for an agent's edit, so a broad edit destroys the person's own work.
- Generated material is frozen at the moment it entered the project; never overwrite or delete a material to "fix" it. Add the new take and leave the old one, because the person may want to compare.
- Never assemble the finished file yourself: no direct ffmpeg run, no re-muxing a video by hand. A finished MP4 comes from anyaudio_project mode:"render" only — anything else produces a file the clip bay cannot see, and the project and the delivered file stop agreeing.
- Change the balance with clip gain, not by rendering the material again. A material is finished the moment it exists; a clip's gainDb, pan and fx are playback settings that never re-render anything. Re-generating a whole score to move one number throws away every track's audio to change one field.
- Normalisation happens once, on the first export, and is then frozen. Do not re-normalise a later export: it would cancel the level changes the person made by hand.`

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
  for (const skill of SKILLS) {
    try {
      const content = await readFile(new URL(`./skills/${skill.file}`, import.meta.url), 'utf8')
      skills.register({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        source: SKILL_SOURCE,
        content,
        provider: 'any-audio',
      })
      log(`registered skill "${skill.name}"`)
    } catch (error) {
      log(`skill registration failed for ${skill.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
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
  const options = { tools: true, skill: true, prompt: true, routes: true, timeline: true, ...config }
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[any-audio] ${message}`)
    } catch {
      // logging must never break plugin loading
    }
  }

  try {
    setWorkingDirectoryService(safeGet(ctx, 'workingDirectory'))
    setSfxHostServices({
      attachments: safeGet(ctx, 'attachments'),
      llm: safeGet(ctx, 'llm'),
    })
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['workingDirectory'], (sctx) => setWorkingDirectoryService(sctx.workingDirectory))
      } catch {
        // the direct lookup above stays as the fallback
      }
      try {
        ctx.inject(['attachments', 'llm'], (sctx) => setSfxHostServices({
          attachments: sctx.attachments,
          llm: sctx.llm,
        }))
      } catch {
        // the direct lookup above stays as the fallback
      }
    }
    if (options.tools) log(`registered tools: ${registerAllTools(ctx, log)}`)
    if (options.skill) void installSkill(ctx, log)
    if (options.prompt) installPromptSection(ctx, log)
    if (options.timeline) {
      try {
        registerTimelineExpansion(ctx, log)
      } catch (error) {
        log(`timeline reference hook failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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
