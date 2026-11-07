import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readConfig } from '../config.js'
import { EDGE_VOICES, MIMO_VOICES, TTS_PROVIDERS, providerInfo, resolveVoice, synthesizeSpeech } from '../audio/tts-providers.js'
import { encodeWav, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { attachMaterialFile } from '../project/attach.js'
import { deliverCopy, deliveryPath, finalizeTool, nowStamp, relativeToWorkspace, requireProjectId, stagePath, textRenderer, workspaceRootOf } from './shared.js'

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

/**
 * Settle the engine of every item before anything else happens.
 *
 * The top-level `provider` is a default, not a verdict: an item may name its own
 * engine, and that choice decides which key is needed and which per-engine
 * defaults apply. Resolving it late — after a MiMo key was demanded for the
 * whole batch — used to reject an all-edge batch whenever the configured
 * default was MiMo.
 *
 * @param items - normalised items, each optionally carrying `provider`
 * @param fallbackProvider - the top-level provider or the configured default
 * @returns the same items with `provider` filled in, plus whether any of them
 *   will actually need a MiMo key
 * @throws when an item names an engine this plugin does not implement
 */
export function resolveProviders(items, fallbackProvider, { explicitFallback = false } = {}) {
  const switches = []
  for (const item of items) {
    const named = item.provider !== undefined && item.provider !== null && String(item.provider).trim() !== ''
    const chosen = String(named ? item.provider : fallbackProvider)
    if (!providerInfo(chosen)) {
      throw new Error(`unknown TTS provider "${chosen}"; use ${Object.keys(TTS_PROVIDERS).join(' or ')}`)
    }
    item.provider = chosen
    const wanted = typeof item.voice === 'string' ? item.voice.trim() : ''
    if (!wanted) continue
    // A voice name identifies its engine, so a voice from another engine is
    // evidence about which one the caller meant. That is only allowed to
    // override a configured default — never an engine the caller named.
    const resolved = resolveVoice({
      provider: chosen,
      voice: wanted,
      explicitProvider: named || explicitFallback,
    })
    if (resolved.switched) {
      item.provider = resolved.provider
      switches.push({ voice: wanted, from: chosen, to: resolved.provider, label: item.label })
    }
  }
  return { items, switches, needsMimoKey: items.some((item) => item.provider === 'mimo' && item.text) }
}

export const ttsToolDefinition = finalizeTool({
  name: 'anyaudio_tts',
  description:
    'Synthesize narration and add it to a clip bay project as material on a track, so the person can open, hear and adjust it. ' +
    'This is the only supported way to make narration for a video: it honours the engine and voice the user picked in Settings → AnyAudio, so do not shell out to edge-tts or any other TTS library. ' +
    'Pass projectId: the lines are placed on its narration track one after another, and a copy of each WAV is kept under the project folder — that copy is what the project plays, the "output" path is only an extra deliverable. ' +
    'Two providers: "edge" (no key, unofficial Microsoft Edge service, MP3 → WAV via ffmpeg) and "mimo" (MiMo-V2.5-TTS, needs a normal Open Platform API key saved in Settings → AnyAudio). ' +
    `When "provider" is omitted the configured default is used. A voice name belongs to one engine and never works on another; the tool is told which engine owns a name, and settles it for you when the engine came from configuration alone — pass "provider" explicitly to override that. ` +
    `Edge voices: ${EDGE_VOICES.join(', ')}. MiMo voices: ${MIMO_VOICES.join(', ')} ("${MIMO_VOICES[0]}" is resolved by the server cluster and may differ between clusters). ` +
    'rate/pitch/volume apply to Edge ("-12%", "-3Hz"); for MiMo they are folded into a style instruction. ' +
    'Pass "style" to steer MiMo delivery, "text" for one clip, or "items" for several. ' +
    'Failures are explicit: missing key, network errors and service errors all throw instead of producing silence.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Narration text for one file.' },
      items: {
        type: 'array',
        description: 'Several narration clips in one call: [{text, provider, voice, rate, pitch, volume, style, output, trackName, startSec}].',
        items: { type: 'object', additionalProperties: true },
      },
      projectId: { type: 'string', description: 'The clip bay project this narration belongs to. Required: run anyaudio_project mode:"create" first when the task has no project yet. Each line is added as material and placed on a track.' },
      trackName: { type: 'string', description: 'Track the narration goes on, default 旁白. Lines land one after another on that track; give each speaker its own name so different voices never share a track. An item may override it with its own trackName.' },
      startSec: { type: 'number', description: 'Where the first line starts on the project timeline. Later lines follow the previous one; an item may set its own startSec.' },
      provider: { type: 'string', enum: ['edge', 'mimo'], description: 'TTS engine. Defaults to the value in Settings → AnyAudio (edge).' },
      voice: { type: 'string', description: 'Voice name. Each name belongs to one engine — pick one from the list for the engine you are using. Defaults to Settings → AnyAudio.' },
      rate: { type: 'string', description: 'Edge speaking rate, e.g. "-12%".' },
      pitch: { type: 'string', description: 'Edge pitch shift, e.g. "-3Hz".' },
      volume: { type: 'string', description: 'Edge volume, e.g. "+0%".' },
      style: { type: 'string', description: 'MiMo style/emotion instruction (not spoken).' },
      proxy: { type: 'string', description: 'Optional proxy override, e.g. "http://127.0.0.1:7890". Defaults to the per-engine proxy configured in Settings → AnyAudio.' },
      output: { type: 'string', description: "Optional extra copy of the WAV at this path. Relative paths resolve against the user's project. The project's own copy is always written under the project folder." },
    },
    required: ['projectId'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        projectId: { type: 'string' },
        provider: { type: 'string' },
        files: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: textRenderer((args, value) => {
      const lines = [`Synthesised narration (${value.provider}):`]
      for (const file of value.files ?? []) {
        const where = file.attached ? ` → project track "${file.attached.trackName}" @ ${Number(file.attached.startSec).toFixed(2)}s` : ''
        lines.push(`- ${file.durationSec.toFixed(2)}s, peak ${file.peakDb} dBFS → ${file.file} [${file.voice}]${where}`)
        if (file.delivered) lines.push(`  delivered copy: ${file.delivered}`)
      }
      if (value.warnings?.length) lines.push(`Warnings:\n${value.warnings.map((warning) => `- ${warning}`).join('\n')}`)
      lines.push(`In project ${value.projectId}. Next: add music and effects with their own projectId, then render the project for the finished file.`)
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const { config } = await readConfig()
    const projectId = requireProjectId(args, 'anyaudio_tts')
    const provider = String(args.provider ?? config.tts.provider)
    const info = providerInfo(provider)
    if (!info) throw new Error(`unknown TTS provider "${provider}"; use ${Object.keys(TTS_PROVIDERS).join(' or ')}`)
    const warnings = []
    const sampleRate = 48000

    const items = Array.isArray(args.items) && args.items.length > 0
      ? args.items.map((item, index) => ({ ...item, text: String(item?.text ?? '').trim(), output: item?.output, label: `item #${index + 1}` }))
      : [{ text: String(args.text ?? '').trim(), output: args.output, label: 'text' }]
    if (items.length === 1 && !items[0].text) throw new Error('anyaudio_tts needs "text" or a non-empty "items" array')

    const { switches } = resolveProviders(items, provider, { explicitFallback: args.provider !== undefined && args.provider !== null })
    const needsMimoKey = items.some((item) => item.provider === 'mimo' && item.text)
    const mimoKey = needsMimoKey ? await resolveMimoKey() : null
    for (const change of switches) {
      warnings.push(
        `${change.label}: voice "${change.voice}" belongs to ${providerInfo(change.to).label}, so it is synthesised with ${providerInfo(change.to).label} instead of the configured ${providerInfo(change.from).label}. Pass "provider": "${change.from}" to force the other engine.`,
      )
    }

    const stamp = nowStamp()
    const files = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const label = items.length > 1 ? `item #${index + 1}` : 'text'
      const itemProvider = item.provider
      const itemInfo = providerInfo(itemProvider)
      if (!item.text) {
        warnings.push(`${label} has no text and was skipped`)
        continue
      }
      if (itemProvider === 'mimo' && !mimoKey) {
        // One item asking for an engine it cannot reach must not sink the batch:
        // report it and keep synthesising the rest.
        warnings.push(`${label} (mimo) was skipped: MiMo TTS needs an API key. Save one in Settings → AnyAudio (stored in the DSH credential store) or set MIMO_API_KEY. This plugin supports normal Open Platform API keys, not Token Plan keys.`)
        continue
      }
      if (item.text.length > 4000) warnings.push(`${label}: ${item.text.length} characters — the service may truncate long input`)
      // `resolveProviders` already settled the engine from the voice, so this
      // only has to fill in the configured voice when none was named.
      const voice = typeof item.voice === 'string' && item.voice.trim()
        ? item.voice.trim()
        : (itemProvider === 'mimo' ? config.tts.mimo.voice : config.tts.edge.voice)
      // Rate/pitch/volume are Edge-only fields; MiMo gets its delivery from `style`.
      const edgeRate = item.rate ?? config.tts.edge.rate
      const edgePitch = item.pitch ?? config.tts.edge.pitch
      const edgeVolume = item.volume ?? config.tts.edge.volume
      const style = itemProvider === 'mimo'
        ? [config.tts.mimo.style, item.style, styleFromLegacy({ rate: edgeRate, pitch: edgePitch })].filter((part) => typeof part === 'string' && part.trim()).join('。')
        : undefined
      const target = stagePath(workspaceRoot, items.length > 1 ? `speech-${stamp}-${index + 1}.wav` : `speech-${stamp}.wav`)
      await mkdir(dirname(target), { recursive: true })
      let audio
      try {
        audio = await synthesizeSpeech({
          provider: itemProvider,
          text: item.text,
          voice,
          rate: edgeRate,
          pitch: edgePitch,
          volume: edgeVolume,
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
        throw new Error(`${itemInfo.label} failed for ${label}: ${describeError(error)}`)
      }
      const wav = encodeWav({ sampleRate: audio.sampleRate, channels: audio.channels, bitDepth: 16 })
      await (await import('node:fs/promises')).writeFile(target, wav)
      const pcm = audio.channels
      // Narration lines land one after another on one track by default: a
      // character's lines are versions of each other, and a person adjusts them
      // as a group (spec §5.3). `trackName` splits them by speaker instead.
      const speaker = String(item.trackName ?? args.trackName ?? '').trim() || '旁白'
      const attached = await attachMaterialFile(workspaceRoot, projectId, target, {
        kind: 'tts',
        trackName: speaker,
        category: 'tts',
        snapshot: { text: item.text, provider: itemProvider, voice },
        snapshotKind: 'tts',
        tool: 'anyaudio_tts',
        label: item.text.slice(0, 24),
        startSec: item.startSec !== undefined ? item.startSec : args.startSec,
        autoStart: true,
      })
      const delivered = await deliverCopy(target, deliveryPath({
        workspaceRoot,
        outputDir: config.output.dir,
        requested: item.output,
        stagedPath: target,
      }))
      files.push({
        file: relativeToWorkspace(workspaceRoot, target),
        absolutePath: target,
        ...(delivered ? { delivered: relativeToWorkspace(workspaceRoot, delivered), deliveredAbsolutePath: delivered } : {}),
        durationSec: Number((pcm[0].length / audio.sampleRate).toFixed(3)),
        sampleRate: audio.sampleRate,
        peakDb: Number(toDb(peakOf(pcm)).toFixed(1)),
        rmsDb: Number(toDb(rmsOf(pcm)).toFixed(1)),
        provider: itemProvider,
        voice,
        text: item.text.slice(0, 120),
        attached,
      })
    }
    if (files.length === 0) {
      throw new Error(warnings.length > 0 ? `no narration was produced: ${warnings.join('; ')}` : 'no narration was produced')
    }
    // The top-level `provider` is only the default a batch may override, so the
    // reported engine is whatever the produced files actually used: one name for
    // a single-engine batch, the mixed list otherwise. Reporting the configured
    // default here would say "mimo" for a batch of edge files.
    const usedProviders = [...new Set(files.map((file) => file.provider))]
    return { ok: true, projectId, provider: usedProviders.length === 1 ? usedProviders[0] : usedProviders.join('+'), files, warnings }
  },
})

export function registerTtsTool(ctx) {
  ctx.tools.register(ttsToolDefinition)
}

