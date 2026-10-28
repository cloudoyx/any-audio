import { registerMixTool } from './mix.js'
import { registerMusicTool } from './music.js'
import { registerSfxTool } from './sfx.js'
import { registerSourcesTool } from './sources.js'
import { registerTtsTool } from './tts.js'

export const TOOL_REGISTRARS = [
  ['anyaudio_music', registerMusicTool],
  ['anyaudio_tts', registerTtsTool],
  ['anyaudio_sfx', registerSfxTool],
  ['anyaudio_mix', registerMixTool],
  ['anyaudio_sources', registerSourcesTool],
]

export function registerAllTools(ctx, log = () => {}) {
  let registered = 0
  for (const [name, register] of TOOL_REGISTRARS) {
    try {
      register(ctx)
      registered++
    } catch (error) {
      log(`could not register ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return registered
}

export { sourcesToolDefinition } from './sources.js'
export { mixToolDefinition } from './mix.js'
export { musicToolDefinition } from './music.js'
export { sfxToolDefinition } from './sfx.js'
export { ttsToolDefinition } from './tts.js'
