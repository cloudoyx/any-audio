import { compileScore } from '../audio/score.js'
import { loadSoundBank, renderCompiled } from '../audio/synth.js'
import { findRecommendedByFile, listFonts, sha256File } from '../audio/fonts.js'
import { renderSfxTimeline, SFX_HELP, SFX_TYPES } from '../audio/sfx.js'
import { listSfxPresets, resolveSfxPreset, SFX_FONTS, SFX_GROUPS } from '../audio/sfx-presets.js'
import { fromDb, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { finalizeTool, nowStamp, readJsonParam, relativeToWorkspace, resolveOutputPath, seconds as clampSeconds, textRenderer, workspaceRootOf, writeWavFile } from './shared.js'
import { readConfig } from '../config.js'

function normalizeTimeline(channels, targetPeakDb) {
  if (targetPeakDb === null || targetPeakDb === undefined) return channels
  const peak = peakOf(channels)
  if (peak <= 0) return channels
  const target = Math.pow(10, Number(targetPeakDb) / 20)
  const gain = target / peak
  return channels.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = channel[i] * gain
    return out
  })
}

function addSegment(target, source, offsetFrames, gainDb, fadeInSec, fadeOutSec, sampleRate) {
  const gain = Number.isFinite(gainDb) ? fromDb(gainDb) : 1
  const start = Math.max(0, Math.round(offsetFrames))
  const fadeIn = Math.max(0, Math.round((fadeInSec ?? 0) * sampleRate))
  const fadeOut = Math.max(0, Math.round((fadeOutSec ?? 0) * sampleRate))
  const length = Math.min(source.length, target.length - start)
  for (let i = 0; i < length; i++) {
    let envelope = 1
    if (fadeIn > 0 && i < fadeIn) envelope *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn)
    const tail = length - 1 - i
    if (fadeOut > 0 && tail < fadeOut) envelope *= 0.5 - 0.5 * Math.cos((Math.PI * tail) / fadeOut)
    target[i] = target[i] + source[i] * gain * envelope
  }
}

function installedFontPaths(fonts) {
  const map = new Map()
  for (const font of fonts) {
    const recommended = findRecommendedByFile(font.name)
    if (recommended) map.set(recommended.id, font.path)
  }
  return map
}

const hashCache = new Map()

async function fontCalibration(fontId, fontPath) {
  const recommended = findRecommendedByFile(basename(fontPath))
  let sha = null
  try {
    const info = await stat(fontPath)
    const key = `${fontPath}:${info.size}:${info.mtimeMs}`
    sha = hashCache.get(key) ?? null
    if (!sha) {
      sha = await sha256File(fontPath)
      hashCache.set(key, sha)
    }
  } catch {
    sha = null
  }
  const expected = recommended?.sha256 ?? null
  return {
    font: fontId,
    file: basename(fontPath),
    expected,
    actual: sha,
    match: expected && sha ? expected === sha : null,
    note: expected && sha && expected !== sha ? `${fontId}: the bank file differs from the version the preset levels were measured on; rise/peak values may be off` : null,
  }
}

async function renderPresetItem(item, { sampleRate, durationSec, paths, bankCache }) {
  const wanted = item.preset ?? item.sfx ?? item.type
  const entry = resolveSfxPreset(wanted, { fonts: [...paths.keys()] })
  if (!entry) {
    throw new Error(
      `unknown SFX preset "${wanted}". Run anyaudio_sfx with action:"catalog" to see the presets built into the default banks (${SFX_FONTS.join(', ')}), or use one of the procedural types: ${SFX_TYPES.join(', ')}.`,
    )
  }
  const fontPath = paths.get(entry.font)
  if (!fontPath) {
    throw new Error(
      `the preset "${entry.id}" needs the ${entry.font} bank, which is not installed. Install it with anyaudio_sources action:"install" (id:"${entry.font}").`,
    )
  }
  let bank = bankCache.get(entry.font)
  if (!bank) {
    bank = await loadSoundBank(fontPath)
    bankCache.set(entry.font, bank)
  }
  const note = Number.isFinite(Number(item.note)) ? Math.max(0, Math.min(127, Math.round(Number(item.note)))) : 60
  const velocity = Number.isFinite(Number(item.velocity)) ? Math.max(1, Math.min(127, Math.round(Number(item.velocity)))) : 100
  const naturalLength = entry.shape === 'sustained' ? 4 : entry.lengthSec + 0.4
  const holdSec = Number.isFinite(Number(item.durationSec))
    ? Math.max(0.2, Math.min(120, Number(item.durationSec)))
    : Math.max(0.2, Math.min(120, naturalLength))
  const compiled = compileScore(
    {
      title: `sfx-${entry.id}`,
      tracks: [
        {
          name: 'fx',
          instrument: { program: entry.program, bank: entry.bank },
          gainDb: 0,
          notes: [[0, holdSec, note, velocity]],
        },
      ],
    },
    { sampleRate },
  )
  const rendered = await renderCompiled(compiled, {
    banks: [{ bank, id: 'fx', offset: 0 }],
    layout: new Map([['fx', { source: 'fx', offset: 0, program: entry.program, bankId: 'fx' }]]),
    sampleRate,
    durationSec: Math.min(durationSec, holdSec + 2.5),
    normalize: false,
  })
  return { entry, channels: rendered.channels, holdSec, note, velocity }
}

export const sfxToolDefinition = finalizeTool({
  name: 'anyaudio_sfx',
  description:
    'Synthesise a timeline of sound effects and write a WAV. Two engines: ' +
    '① presets from the default SoundFont banks — {preset:"rain"} or {preset:"gun-shot"}; these are real samples of birds, seashore, wind, door, car, applause, explosion and so on (run action:"catalog" to see them with notes on shape and level); ' +
    '② procedural generators — {type:"wind"} etc. (wind, rain, water, fire, birds, footsteps, stones, whoosh, impact, bell, gong, drum, riser, heartbeat, thunder). ' +
    'Items are placed on the video timeline in seconds and mix together: {items:[{preset|type, startSec, durationSec?, gainDb?, fadeInSec?, fadeOutSec?, note?, velocity?, params?, seed?}], durationSec}. ' +
    'Use presets for recognisable real-world sounds, procedural generators when no preset fits or when you need a controllable bed. Music itself comes from anyaudio_music; narration from anyaudio_tts.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: "Set to \"catalog\" to list the sound-effect presets in the default banks (optionally filter with group/query). Otherwise omit and pass items." },
      items: { type: 'array', description: 'SFX events: preset or type, startSec, optional durationSec/gainDb/fades/note/velocity/params/seed.', items: { type: 'object', additionalProperties: true } },
      output: { type: 'string', description: "Output WAV path. Relative paths resolve against the user's project; defaults to <project>/.anyaudio/out/sfx-<timestamp>.wav." },
      durationSec: { type: 'number', description: 'Total timeline length; defaults to the latest item end.' },
      sampleRate: { type: 'number', description: 'Sample rate, default 48000.' },
      peakDb: { type: 'number', description: 'Peak normalisation in dBFS, default -4. null keeps raw level.' },
      group: { type: 'string', description: 'Catalog filter: noise, weather, animals, home, traffic, crowd or weapons.' },
      query: { type: 'string', description: 'Catalog search text (name, Chinese name or tag).' },
    },
    required: [],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        peakDb: { type: 'number' },
        rmsDb: { type: 'number' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        presets: { type: 'array', items: { type: 'object', additionalProperties: true } },
        calibration: { type: 'array', items: { type: 'object', additionalProperties: true } },
        warnings: { type: 'array' },
      },
    },
    render: textRenderer((args, value) => {
      if (value.action === 'catalog') {
        const lines = [
          `Sound-effect presets in the default banks: ${value.presets.length} (installed: ${value.installed.join(', ') || 'none'})`,
          'Groups: ' + value.groups.map((entry) => `${entry.id} (${entry.label})`).join(', '),
          'Use {items:[{preset:"rain", startSec:0, durationSec:20}]} to place them; durationSec is optional (sustained presets hold, one-shots play their natural tail).',
          '',
        ]
        let current = null
        for (const preset of value.presets) {
          if (preset.group !== current) {
            current = preset.group
            lines.push(`## ${current} — ${value.groups.find((entry) => entry.id === current)?.label ?? ''}`)
          }
          lines.push(`- ${preset.name} (${preset.zh}) · ${preset.shape === 'sustained' ? 'sustained' : `one-shot ${preset.lengthSec.toFixed(2)}s`} · rise ${preset.riseSec.toFixed(2)}s · peak ${preset.peakDb.toFixed(1)}dBFS · ${preset.font} · note ${preset.note}`)
        }
        for (const item of value.calibration ?? []) {
          if (item.match === false) lines.push('', `! ${item.note}`)
        }
        return lines.join('\n')
      }
      const lines = [
        `Created ${value.durationSec.toFixed(2)}s SFX bed → ${value.file} (peak ${value.peakDb.toFixed(1)} dBFS, RMS ${value.rmsDb.toFixed(1)} dBFS)`,
        'Events:',
        ...value.items.map((item) => {
          if (item.preset) return `- preset ${item.presetName} @ ${item.startSec.toFixed(2)}s for ${item.durationSec.toFixed(2)}s (${item.font}, gain ${item.gainDb}dB)`
          return `- ${item.type} @ ${item.startSec.toFixed(2)}s for ${item.durationSec.toFixed(2)}s`
        }),
        'Procedural types: ' + SFX_TYPES.join(', '),
        'SFX presets: run action:"catalog" to list the default-bank sound effects.',
        ...(value.warnings ?? []).map((warning) => `! ${warning}`),
      ]
      return lines.join('\n')
    }),
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const { config } = await readConfig()
    const fonts = await listFonts()
    const paths = installedFontPaths(fonts)

    if (String(args.action ?? '').toLowerCase() === 'catalog') {
      const presets = listSfxPresets({ fonts: [...paths.keys()], group: args.group, query: args.query })
      const calibration = []
      for (const fontId of SFX_FONTS) {
        const fontPath = paths.get(fontId)
        if (fontPath) calibration.push(await fontCalibration(fontId, fontPath))
      }
      return {
        ok: true,
        action: 'catalog',
        groups: Object.entries(SFX_GROUPS).map(([id, label]) => ({ id, label })),
        presets: presets.map((entry) => ({ ...entry, note: entry.note, installed: paths.has(entry.font) })),
        installed: [...paths.keys()],
        calibration,
      }
    }

    const items = Array.isArray(args.items) ? args.items : await readJsonParam(args.items, 'items')
    if (!Array.isArray(items) || items.length === 0) throw new Error('items must be a non-empty array (or use action:"catalog")')
    const sampleRate = Math.round(clampSeconds(args.sampleRate ?? config.sfx.sampleRate, config.sfx.sampleRate)) || config.sfx.sampleRate
    const latestEnd = items.reduce((max, item) => {
      const start = Number(item.startSec ?? item.start ?? 0)
      const length = Number(item.durationSec ?? item.duration ?? 0)
      return Math.max(max, (Number.isFinite(start) ? start : 0) + (Number.isFinite(length) ? length : 0))
    }, 0)
    const durationSec = clampSeconds(args.durationSec, latestEnd || 1)

    const procedural = []
    const presets = []
    for (const item of items) {
      if (item && (item.preset || item.sfx)) presets.push(item)
      else procedural.push(item)
    }

    const totalFrames = Math.max(1, Math.ceil(durationSec * sampleRate))
    const mixed = [new Float32Array(totalFrames), new Float32Array(totalFrames)]
    const report = []
    const bankCache = new Map()

    if (procedural.length > 0) {
      const rendered = renderSfxTimeline({ items: procedural, durationSec, sampleRate })
      for (let channel = 0; channel < 2; channel++) {
        const source = rendered.channels[channel] ?? rendered.channels[0]
        for (let i = 0; i < Math.min(source.length, totalFrames); i++) mixed[channel][i] += source[i]
      }
      report.push(...rendered.report)
    }

    for (const item of presets) {
      const rendered = await renderPresetItem(item, { sampleRate, durationSec, paths, bankCache })
      const startSec = Math.max(0, Number(item.startSec ?? item.start ?? 0) || 0)
      const gainDb = Number.isFinite(Number(item.gainDb)) ? Number(item.gainDb) : 0
      const segmentPeak = peakOf(rendered.channels)
      const segmentRms = rmsOf(rendered.channels)
      for (let channel = 0; channel < 2; channel++) {
        addSegment(
          mixed[channel],
          rendered.channels[channel] ?? rendered.channels[0],
          startSec * sampleRate,
          gainDb,
          item.fadeInSec,
          item.fadeOutSec,
          sampleRate,
        )
      }
      report.push({
        preset: rendered.entry.id,
        presetName: `${rendered.entry.name}（${rendered.entry.zh}）`,
        font: rendered.entry.font,
        program: rendered.entry.program,
        bank: rendered.entry.bank,
        startSec,
        durationSec: rendered.channels[0].length / sampleRate,
        gainDb,
        peakDb: Number(toDb(segmentPeak).toFixed(2)),
        rmsDb: Number(toDb(segmentRms).toFixed(2)),
      })
    }

    const peakDbRequested = args.peakDb === undefined ? config.sfx.peakDb : args.peakDb
    const channels = normalizeTimeline(mixed, peakDbRequested)
    const usedFonts = [...new Set(report.filter((entry) => entry.preset).map((entry) => entry.font))]
    const calibration = []
    for (const fontId of usedFonts) {
      const fontPath = paths.get(fontId)
      if (fontPath) calibration.push(await fontCalibration(fontId, fontPath))
    }
    const warnings = calibration.filter((item) => item.note).map((item) => item.note)
    const target = resolveOutputPath({ workspaceRoot, outputDir: config.output.dir, requested: args.output, defaultName: `sfx-${nowStamp()}.wav` })
    const written = await writeWavFile(target, channels, sampleRate)
    return {
      ok: true,
      file: relativeToWorkspace(workspaceRoot, written.path),
      absolutePath: written.path,
      durationSec: Number((channels[0].length / sampleRate).toFixed(3)),
      sampleRate,
      peakDb: Number(toDb(peakOf(channels)).toFixed(2)),
      rmsDb: Number(toDb(rmsOf(channels)).toFixed(2)),
      items: report,
      calibration,
      warnings,
      help: SFX_HELP,
    }
  },
})

export function registerSfxTool(ctx) {
  ctx.tools.register(sfxToolDefinition)
}
