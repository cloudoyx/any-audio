import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readConfig } from '../config.js'
import { EDGE_VOICES, MIMO_VOICES, TTS_PROVIDERS, providerInfo, synthesizeSpeech } from '../audio/tts-providers.js'
import { encodeWav, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { finalizeTool, nowStamp, relativeToWorkspace, resolveOutputPath, textRenderer, workspaceRootOf } from './shared.js'

let credentialResolver = null

/** Wired by the plugin; tests can inject their own resolver. */
export function setCredentialResolver(resolver) {
  credentialResolver = resolver
}

async function resolveMimoKey() {
  const env = process.env.MIMO_API_KEY
  if (env && env.trim()) return env.trim()
  if (!credentialResolver) return null
  try {
    const resolved = await credentialResolver('MIMO_API_KEY')
    return resolved?.value ?? null
  } catch {
    return null
  }
}

function describeError(error) {
  const raw = error instanceof Error ? error.message : String(error)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|network|websocket/i.test(raw)) {
    return `${raw}. Edge TTS and MiMo are network services: check connectivity or configure a proxy in Settings → AnyAudio.`
  }
  return raw
}

function styleFromLegacy({ rate, pitch }) {
  const parts = []
  if (rate !== undefined && rate !== null && String(rate).trim()) parts.push(`语速 ${String(rate).trim()}`)
  if (pitch !== undefined && pitch !== null && String(pitch).trim()) parts.push(`音高 ${String(pitch).trim()}`)
  return parts.join('，')
}

export const ttsToolDefinition = finalizeTool({
  name: 'anyaudio_tts',
  description:
    'Synthesize narration and write 48 kHz mono WAV files that anyaudio_mix can place on a video timeline. ' +
    'This is the only supported way to make narration for a video: it honours the engine and voice the user picked in Settings → AnyAudio, so do not shell out to edge-tts or any other TTS library. ' +
    'Two providers: "edge" (no key, unofficial Microsoft Edge service, MP3 → WAV via ffmpeg) and "mimo" (MiMo-V2.5-TTS, needs a normal Open Platform API key saved in Settings → AnyAudio). ' +
    `When "provider" is omitted the configured default is used. Edge voices include ${EDGE_VOICES.join(', ')} (default zh-CN-YunjianNeural). MiMo voices include ${MIMO_VOICES.join(', ')}; "${MIMO_VOICES[0]}" is resolved by the server cluster and may differ between clusters. ` +
    'rate/pitch/volume apply to Edge ("-12%", "-3Hz"); for MiMo they are folded into a style instruction. ' +
    'Pass "style" to steer MiMo delivery, "text" for one clip, or "items" for several. ' +
    'Failures are explicit: missing key, network errors and service errors all throw instead of producing silence.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Narration text for one file.' },
      items: {
        type: 'array',
        description: 'Several narration clips in one call: [{text, provider, voice, rate, pitch, volume, style, output}].',
        items: { type: 'object', additionalProperties: true },
      },
      provider: { type: 'string', enum: ['edge', 'mimo'], description: 'TTS engine. Defaults to the value in Settings → AnyAudio (edge).' },
      voice: { type: 'string', description: 'Voice name for the selected provider. Defaults to Settings → AnyAudio.' },
      rate: { type: 'string', description: 'Edge speaking rate, e.g. "-12%".' },
      pitch: { type: 'string', description: 'Edge pitch shift, e.g. "-3Hz".' },
      volume: { type: 'string', description: 'Edge volume, e.g. "+0%".' },
      style: { type: 'string', description: 'MiMo style/emotion instruction (not spoken).' },
      proxy: { type: 'string', description: 'Optional proxy override, e.g. "http://127.0.0.1:7890". Defaults to the per-engine proxy configured in Settings → AnyAudio.' },
      output: { type: 'string', description: "Output WAV path for the single-text form. Relative paths resolve against the user's project; defaults to <project>/.anyaudio/out/speech-<timestamp>.wav." },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        provider: { type: 'string' },
        files: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      const lines = [`Synthesised narration (${value.provider}):`]
      for (const file of value.files ?? []) {
        lines.push(`- ${file.durationSec.toFixed(2)}s, peak ${file.peakDb} dBFS → ${file.file} [${file.voice}]`)
      }
      if (value.warnings?.length) lines.push(`Warnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`)
      lines.push('Place these files on the timeline with anyaudio_mix (role "narration" so the music ducks under them).')
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const { config } = await readConfig()
    const provider = String(args.provider ?? config.tts.provider)
    const info = providerInfo(provider)
    if (!info) throw new Error(`unknown TTS provider "${provider}"; use ${Object.keys(TTS_PROVIDERS).join(' or ')}`)
    const warnings = []
    const defaults = provider === 'mimo' ? config.tts.mimo : config.tts.edge
    const sampleRate = 48000

    const items = Array.isArray(args.items) && args.items.length > 0
      ? args.items.map((item, index) => ({ ...item, text: String(item?.text ?? '').trim(), output: item?.output, label: `item #${index + 1}` }))
      : [{ text: String(args.text ?? '').trim(), output: args.output, label: 'text' }]
    if (items.length === 1 && !items[0].text) throw new Error('anyaudio_tts needs "text" or a non-empty "items" array')

    const mimoKey = provider === 'mimo' ? await resolveMimoKey() : null
    if (provider === 'mimo' && !mimoKey) {
      throw new Error('MiMo TTS needs an API key. Save one in Settings → AnyAudio (stored in the DSH credential store) or set MIMO_API_KEY. This plugin supports normal Open Platform API keys, not Token Plan keys.')
    }

    const stamp = nowStamp()
    const files = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const label = items.length > 1 ? `item #${index + 1}` : 'text'
      const itemProvider = String(item.provider ?? provider)
      if (!item.text) {
        warnings.push(`${label} has no text and was skipped`)
        continue
      }
      if (item.text.length > 4000) warnings.push(`${label}: ${item.text.length} characters — the service may truncate long input`)
      const voice = String(item.voice ?? (itemProvider === 'mimo' ? config.tts.mimo.voice : config.tts.edge.voice))
      const style = itemProvider === 'mimo'
        ? [config.tts.mimo.style, item.style, styleFromLegacy({ rate: item.rate, pitch: item.pitch })].filter((part) => typeof part === 'string' && part.trim()).join('。')
        : undefined
      const target = resolveOutputPath({ workspaceRoot, outputDir: config.output.dir, requested: item.output, defaultName: items.length > 1 ? `speech-${stamp}-${index + 1}.wav` : `speech-${stamp}.wav` })
      await mkdir(dirname(target), { recursive: true })
      let audio
      try {
        audio = await synthesizeSpeech({
          provider: itemProvider,
          text: item.text,
          voice,
          rate: item.rate ?? config.tts.edge.rate,
          pitch: item.pitch ?? config.tts.edge.pitch,
          volume: item.volume ?? config.tts.edge.volume,
          style: itemProvider === 'mimo' ? style : item.style,
          proxy: typeof item.proxy === 'string' && item.proxy.trim()
            ? item.proxy.trim()
            : (itemProvider === 'mimo' ? config.tts.mimo.proxy : config.tts.edge.proxy) || undefined,
          baseUrl: config.tts.mimo.baseUrl,
          model: config.tts.mimo.model,
          timeoutSec: config.tts.mimo.timeoutSec,
          apiKey: mimoKey,
          sampleRate,
          signal: exec?.signal,
        })
      } catch (error) {
        throw new Error(`${info.label} failed for ${label}: ${describeError(error)}`)
      }
      const wav = encodeWav({ sampleRate: audio.sampleRate, channels: audio.channels, bitDepth: 16 })
      await (await import('node:fs/promises')).writeFile(target, wav)
      const pcm = audio.channels
      files.push({
        file: relativeToWorkspace(workspaceRoot, target),
        absolutePath: target,
        durationSec: Number((pcm[0].length / audio.sampleRate).toFixed(3)),
        sampleRate: audio.sampleRate,
        peakDb: Number(toDb(peakOf(pcm)).toFixed(1)),
        rmsDb: Number(toDb(rmsOf(pcm)).toFixed(1)),
        provider: itemProvider,
        voice,
        text: item.text.slice(0, 120),
      })
    }
    if (files.length === 0) throw new Error('no narration was produced')
    return { ok: true, provider, files, warnings }
  },
})

export function registerTtsTool(ctx) {
  ctx.tools.register(ttsToolDefinition)
}

