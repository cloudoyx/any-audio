import { compileScore } from '../audio/score.js'
import { loadSoundBank, renderCompiled } from '../audio/synth.js'
import { findRecommendedByFile, listFonts, sha256File } from '../audio/fonts.js'
import { renderSfxMaterial, renderSfxTimeline, SFX_HELP, SFX_TYPES, categoryOf } from '../audio/sfx.js'
import { listSfxPresets, resolveSfxPreset, SFX_FONTS, SFX_GROUPS } from '../audio/sfx-presets.js'
import { fromDb, padOrTrim, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { finalizeTool, deliverCopy, deliveryPath, nowStamp, readJsonParam, relativeToWorkspace, requireProjectId, resolveOutputPath, seconds as clampSeconds, stagePath, textRenderer, workspaceRootOf, writeWavFile } from './shared.js'
import { readConfig } from '../config.js'
import { attachMaterialFile } from '../project/attach.js'

/** Effect categories map onto the project's track categories (spec §5.2). */
const SFX_TRACK_CATEGORY = { 环境音: 'ambience', 动效: 'foley', 其他: 'other' }

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

async function renderMaterials(args, projectId, items, { workspaceRoot, config, paths }) {
  const sampleRate = Math.round(clampSeconds(args.sampleRate ?? config.sfx.sampleRate, config.sfx.sampleRate)) || config.sfx.sampleRate
  // Materials are written into `.anyaudio/out/` first: the project copy is what
  // the person edits, so it must exist before anything is delivered elsewhere.
  const directory = stagePath(workspaceRoot, `sfx-materials-${nowStamp()}`)
  await mkdir(directory, { recursive: true })

  const fallbackLength = Number.isFinite(Number(args.durationSec)) ? Number(args.durationSec) : null
  const bankCache = new Map()
  const usedFonts = new Set()
  const materials = []
  const taken = new Set()

  for (const [index, item] of items.entries()) {
    const gainDb = Number.isFinite(Number(item.gainDb)) ? Number(item.gainDb) : 0
    let channels
    let entry = null
    let lengthSec
    if (item.preset || item.sfx) {
      const rendered = await renderPresetItem(item, { sampleRate, durationSec: fallbackLength ?? 60, paths, bankCache })
      entry = rendered.entry
      usedFonts.add(entry.font)
      // A preset renders its release tail on top of the hold, which is right for a
      // timeline but wrong for a material: the project places the file itself, so
      // the file has to be exactly as long as the caller asked for.
      const wanted = Number.isFinite(Number(item.durationSec ?? item.duration))
        ? Number(item.durationSec ?? item.duration)
        : null
      channels = wanted && wanted > 0
        ? padOrTrim(rendered.channels, Math.max(1, Math.round(wanted * sampleRate)))
        : rendered.channels
      lengthSec = channels[0].length / sampleRate
    } else {
      const type = item.type ?? item.name
      if (!type) throw new Error(`sfx item #${index} needs a preset or a type`)
      if (!Number.isFinite(Number(item.durationSec ?? item.duration)) && fallbackLength === null) {
        throw new Error(`sfx item #${index} ("${type}") needs durationSec in materials mode: each material has a length of its own, so there is no timeline to fall back on`)
      }
      const wanted = Number(item.durationSec ?? item.duration ?? fallbackLength)
      if (!Number.isFinite(wanted) || wanted <= 0) throw new Error(`sfx item #${index} has an invalid durationSec`)
      const seed = Number.isFinite(Number(item.seed)) ? Number(item.seed) : index * 104729 + 17
      channels = renderSfxMaterial({ type, durationSec: wanted, sampleRate, params: item.params ?? {}, seed, gainDb })
      lengthSec = channels[0].length / sampleRate
    }

    const slug = (entry?.id ?? item.type ?? item.name ?? 'sfx').replace(/[^A-Za-z0-9_-]+/g, '-')
    let name = `${String(index + 1).padStart(2, '0')}-${slug}.wav`
    if (taken.has(name)) {
      let suffix = 2
      while (taken.has(name)) name = `${String(index + 1).padStart(2, '0')}-${slug}-${suffix++}.wav`
    }
    taken.add(name)
    const written = await writeWavFile(join(directory, name), channels, sampleRate)
    const category = entry ? categoryOf({ group: entry.group }) : categoryOf({ type: item.type ?? item.name })
    const label = entry ? `${entry.name}（${entry.zh}）` : String(item.type ?? item.name)
    // Each effect is its own material on the timeline, placed where the caller
    // asked. Effects that never overlap may share a track (spec §5.2), which is
    // what freeTrack arranges.
    const attached = await attachMaterialFile(workspaceRoot, projectId, written.path, {
      kind: category === '环境音' ? 'ambience' : 'sfx',
      trackName: item.trackName || args.trackName || `音效 · ${category}`,
      category: SFX_TRACK_CATEGORY[category] ?? 'other',
      snapshot: entry ? { preset: entry.id, durationSec: lengthSec, gainDb } : { type: item.type ?? item.name, params: item.params ?? {}, seed: Number.isFinite(Number(item.seed)) ? Number(item.seed) : undefined, durationSec: lengthSec, gainDb },
      snapshotKind: 'sfx',
      tool: 'anyaudio_sfx',
      label,
      startSec: Number.isFinite(Number(item.startSec)) ? Number(item.startSec) : undefined,
    })
    materials.push({
      file: relativeToWorkspace(workspaceRoot, written.path),
      absolutePath: written.path,
      category,
      durationSec: Number(lengthSec.toFixed(3)),
      peakDb: Number(toDb(peakOf(channels)).toFixed(2)),
      rmsDb: Number(toDb(rmsOf(channels)).toFixed(3)),
      ...(entry
        ? { preset: entry.id, presetName: `${entry.name}（${entry.zh}）`, font: entry.font, program: entry.program, bank: entry.bank }
        : { type: item.type ?? item.name }),
      gainDb,
      params: item.params ?? {},
      attached,
    })
  }

  const calibration = []
  for (const fontId of usedFonts) {
    const fontPath = paths.get(fontId)
    if (fontPath) calibration.push(await fontCalibration(fontId, fontPath))
  }
  const warnings = calibration.filter((item) => item.note).map((item) => item.note)
  // A per-file peak target cannot be applied here without silently rebalancing
  // the mix relative to what the caller asked for, and the manifest already
  // reports each peak, so materials mode keeps the raw levels.
  if (args.peakDb !== undefined && args.peakDb !== null) {
    warnings.push('materials mode keeps raw levels; peakDb is ignored because normalising each file separately would change the relative balance between effects')
  }

  const manifestPath = join(directory, 'manifest.json')
  const manifest = {
    mode: 'materials',
    sampleRate,
    createdAt: new Date().toISOString(),
    materials: materials.map((entry) => ({
      file: entry.file,
      category: entry.category,
      durationSec: entry.durationSec,
      peakDb: entry.peakDb,
      rmsDb: entry.rmsDb,
      ...(entry.preset ? { preset: entry.preset } : { type: entry.type }),
      gainDb: entry.gainDb,
      params: entry.params,
    })),
  }
  const { writeFile: writeTextFile } = await import('node:fs/promises')
  await writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // `output` is only where a delivered copy goes. The project already holds the
  // files it plays, so this is a convenience for the person, not the record.
  let deliveredDir = null
  if (typeof args.output === 'string' && args.output.trim()) {
    const requested = args.output.trim()
    deliveredDir = requested.toLowerCase().endsWith('.wav')
      ? dirname(resolveOutputPath({ workspaceRoot, requested, defaultName: 'x.wav' }))
      : resolveOutputPath({ workspaceRoot, requested, defaultName: '.' })
    if (resolve(deliveredDir) !== resolve(directory)) {
      for (const entry of materials) {
        await deliverCopy(entry.absolutePath, join(deliveredDir, basename(entry.absolutePath)))
      }
      await deliverCopy(manifestPath, join(deliveredDir, 'manifest.json'))
    }
  }

  return {
    ok: true,
    projectId,
    mode: 'materials',
    directory: relativeToWorkspace(workspaceRoot, directory),
    absoluteDirectory: directory,
    ...(deliveredDir ? { deliveredDirectory: relativeToWorkspace(workspaceRoot, deliveredDir), deliveredDirectoryAbsolutePath: deliveredDir } : {}),
    manifest: relativeToWorkspace(workspaceRoot, manifestPath),
    sampleRate,
    materials,
    calibration,
    warnings,
  }
}

export const sfxToolDefinition = finalizeTool({
  name: 'anyaudio_sfx',
  description:
    'Synthesise sound effects and add them to a clip bay project, so the person can open, hear and move them. ' +
    'Two engines: ' +
    '① presets from the default SoundFont banks — {preset:"rain"} or {preset:"gun-shot"}; these are real samples of birds, seashore, wind, door, car, applause, explosion and so on (run action:"catalog" to see them with notes on shape and level); ' +
    '② procedural generators — {type:"wind"} etc. (wind, rain, water, fire, birds, footsteps, stones, whoosh, impact, bell, gong, drum, riser, heartbeat, thunder). ' +
    'Two modes, and the default does not change: mode:"timeline" (default) places the items on one timeline and writes a single WAV of durationSec. ' +
    'mode:"materials" writes one short WAV per item, each starting at t=0, plus a manifest with file, category (环境音/动效/其他), duration and peak — this is the mode to use for a clip bay project: every effect becomes its own clip, so one can be moved or dropped without re-rendering the others. ' +
    'Both modes need projectId; the result is placed on a track and a copy of every file is kept under the project folder. ' +
    'Music itself comes from anyaudio_music; narration from anyaudio_tts.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: "Set to \"catalog\" to list the sound-effect presets in the default banks (optionally filter with group/query). Otherwise omit and pass items." },
      projectId: { type: 'string', description: 'The clip bay project these effects belong to. Required whenever you pass items: run anyaudio_project mode:"create" first when the task has no project yet. action:"catalog" does not need it.' },
      trackName: { type: 'string', description: 'Track name, default 音效 · <类别> for materials mode and 音效 for timeline mode. Effects that never overlap in time share one track; overlapping ones move to the next free track automatically.' },
      startSec: { type: 'number', description: 'timeline mode: where the bed starts on the project timeline, default 0. materials mode: the default start for items that name none.' },
      mode: { type: 'string', enum: ['timeline', 'materials'], description: 'How the items become files. "timeline" (default) lays them out on one shared timeline and writes a single WAV. "materials" writes one file per item, each from t=0, plus a manifest — the clip bay then places them itself.' },
      items: { oneOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'string' }], description: 'SFX events: preset or type, optional durationSec/gainDb/fades/note/velocity/params/seed. A path to a .json file holding the array is also accepted. In "materials" mode startSec is ignored and each item becomes its own file; in "timeline" mode it decides where the sound sits.' },
      output: { type: 'string', description: 'Optional extra copy of the delivered file(s). In "timeline" mode the output WAV path; in "materials" mode the folder that receives one file per item plus manifest.json. Relative paths resolve against the user\'s project. The project\'s own copies are always written under the project folder.' },
      durationSec: { type: 'number', description: 'Total timeline length in "timeline" mode; defaults to the latest item end. In "materials" mode it is the fallback length for an item that names none.' },
      sampleRate: { type: 'number', description: 'Sample rate, default 48000.' },
      peakDb: { type: 'number', description: 'Peak normalisation in dBFS, default -4 in "timeline" mode. null keeps raw level. "materials" mode never normalises across files, so one setting cannot silently rebalance the mix.' },
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
        projectId: { type: 'string' },
        mode: { type: 'string' },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        delivered: { type: 'string' },
        deliveredAbsolutePath: { type: 'string' },
        deliveredDirectory: { type: 'string' },
        deliveredDirectoryAbsolutePath: { type: 'string' },
        attached: { type: 'object', additionalProperties: true },
        directory: { type: 'string' },
        manifest: { type: 'string' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        peakDb: { type: 'number' },
        rmsDb: { type: 'number' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        materials: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
      if (value.mode === 'materials') {
        const lines = [
          `Wrote ${value.materials.length} sound material(s) to ${value.directory} → manifest ${value.manifest}`,
          'Materials (each starts at t=0):',
          ...value.materials.map((entry) => `- ${entry.file} · ${entry.category} · ${entry.durationSec.toFixed(2)}s · peak ${entry.peakDb.toFixed(1)} dBFS${entry.attached ? ` → track "${entry.attached.trackName}" @ ${Number(entry.attached.startSec).toFixed(2)}s` : ''}`),
          `In project ${value.projectId}: each effect is its own clip, so one can be moved or dropped without re-rendering the others.`,
          ...(value.warnings ?? []).map((warning) => `! ${warning}`),
        ]
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
        ...(value.attached ? [`In project ${value.projectId}: one clip "${value.attached.trackName}" @ ${Number(value.attached.startSec).toFixed(2)}s. Use mode:"materials" when the events need to stay separately editable.`] : []),
        ...(value.delivered ? [`Delivered copy: ${value.delivered}`] : []),
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

    const items = Array.isArray(args.items) ? args.items : await readJsonParam(args.items, 'items', { workspaceRoot })
    if (!Array.isArray(items) || items.length === 0) throw new Error('items must be a non-empty array (or use action:"catalog")')
    const projectId = requireProjectId(args, 'anyaudio_sfx')
    const mode = String(args.mode ?? 'timeline').toLowerCase()
    if (mode !== 'timeline' && mode !== 'materials') throw new Error(`unknown mode "${args.mode}"; use "timeline" or "materials"`)
    if (mode === 'materials') return renderMaterials(args, projectId, items, { workspaceRoot, config, paths })
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
    const target = stagePath(workspaceRoot, `sfx-${nowStamp()}.wav`)
    const written = await writeWavFile(target, channels, sampleRate)
    // The whole bed is one material on one track: it is a finished effects bed,
    // not a set of separate events, so there is nothing to separate on it.
    const attached = await attachMaterialFile(workspaceRoot, projectId, written.path, {
      kind: 'sfx',
      trackName: args.trackName || '音效',
      category: 'foley',
      snapshot: { mode: 'timeline', items: report },
      snapshotKind: 'sfx',
      tool: 'anyaudio_sfx',
      label: '音效',
      startSec: Number.isFinite(Number(args.startSec)) ? Number(args.startSec) : 0,
    })
    const delivered = await deliverCopy(written.path, deliveryPath({
      workspaceRoot,
      outputDir: config.output.dir,
      requested: args.output,
      stagedPath: written.path,
    }))
    return {
      ok: true,
      projectId,
      file: relativeToWorkspace(workspaceRoot, written.path),
      absolutePath: written.path,
      ...(delivered ? { delivered: relativeToWorkspace(workspaceRoot, delivered), deliveredAbsolutePath: delivered } : {}),
      mode: 'timeline',
      durationSec: Number((channels[0].length / sampleRate).toFixed(3)),
      sampleRate,
      peakDb: Number(toDb(peakOf(channels)).toFixed(2)),
      rmsDb: Number(toDb(rmsOf(channels)).toFixed(2)),
      items: report,
      attached,
      calibration,
      warnings,
      help: SFX_HELP,
    }
  },
})

export function registerSfxTool(ctx) {
  ctx.tools.register(sfxToolDefinition)
}
