import { compileScore } from '../audio/score.js'
import { loadSoundBank, renderCompiled } from '../audio/synth.js'
import { findRecommendedByFile, listFonts, sha256File } from '../audio/fonts.js'
import { renderSfxMaterial, SFX_TYPES, categoryOf } from '../audio/sfx.js'
import { listSfxPresets, resolveSfxPreset, SFX_FONTS, SFX_GROUPS } from '../audio/sfx-presets.js'
import { isPriorityPack, listPacks, packPriority, resolveSound, search as searchLibrary, userSfxDir } from '../audio/sfx-library.js'
import { downloadPreview, searchFreesound } from '../audio/freesound.js'
import { decodeMonoSamples, drawWaveform } from '../audio/waveform-png.js'
import { padOrTrim, peakOf, rmsOf, toDb } from '../audio/wav.js'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { finalizeTool, deliverCopy, findFfmpeg, nowStamp, readJsonParam, relativeToWorkspace, requireProjectId, resolveOutputPath, scratchPath, seconds as clampSeconds, textRenderer, workspaceRootOf, writeWavFile } from './shared.js'
import { readConfig } from '../config.js'
import { attachMaterialFile } from '../project/attach.js'
import { projectDir } from '../project/paths.js'

/** Effect categories map onto the project's track categories (spec §5.2). */
const SFX_TRACK_CATEGORY = { 环境音: 'ambience', 动效: 'foley', 其他: 'other' }

/** How a library sound's type reads on a track, and which track category it is. */
const LIBRARY_TYPE_LABEL = { foley: '动效', ambience: '环境音', dsn: '设计音效' }
const LIBRARY_TYPE_CATEGORY = { foley: 'foley', ambience: 'ambience', dsn: 'other' }

/**
 * The host services the waveform picture needs, injected once at registration.
 *
 * They are looked up lazily because a plugin is applied before every service is
 * mounted, and a missing one must degrade to "no picture" rather than to a
 * broken tool.
 */
let attachmentService = null
let llmService = null

export function setSfxHostServices({ attachments, llm } = {}) {
  if (attachments !== undefined) attachmentService = attachments
  if (llm !== undefined) llmService = llm
}

/**
 * Whether the model behind this call can see an image.
 *
 * The host projects images to text for a text-only model rather than refusing
 * the request, so a picture sent to one is silently replaced by a placeholder —
 * the agent would believe it had looked at a waveform it never saw. Asking first
 * is the only way to know.
 */
async function modelSeesImages(exec) {
  if (!llmService?.resolveModelInfo) return false
  const provider = exec?.agent?.options?.provider
  const model = exec?.agent?.options?.model
  if (!provider || !model) return false
  try {
    const info = await llmService.resolveModelInfo(provider, model, exec?.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
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
  // Scratch, not `out/`: every file here is copied into the project before the
  // call returns, so a second copy in `out/` was a duplicate — measured on a real
  // project as 12.8 MB of non-deliverables, of which the narration WAVs were
  // byte-identical to `materials/` (improvement plan 04). `out/` is where a person
  // looks for what a tool produced, so only a delivered copy belongs there.
  const directory = scratchPath(workspaceRoot, `sfx-materials-${nowStamp()}`)
  await mkdir(directory, { recursive: true })

  const fallbackLength = Number.isFinite(Number(args.durationSec)) ? Number(args.durationSec) : null
  const bankCache = new Map()
  const usedFonts = new Set()
  const materials = []
  const taken = new Set()
  // One decision per track family, not per item: a batch of six whooshes asks
  // "was this family already here?" once, and a `replace` clears it once.
  const replacedFamilies = new Set()
  const layoutNotes = []

  // Replace-or-append, decided per family before the first clip of that family
  // lands. Re-running a batch after changing levels is the ordinary case, and
  // it used to append: the family was busy on the same span, so `freeTrack`
  // opened `音效 · 动效 2` and the project kept both sets. `replace` clears the
  // family first; without it the append still happens (a second take beside the
  // first is a legitimate want) but the reply says what it did.
  async function prepareFamily(trackName) {
    if (replacedFamilies.has(trackName)) return
    replacedFamilies.add(trackName)
    const { readProject, saveProject } = await import('../project/store.js')
    const { trackFamily, removeTrackFamily } = await import('../project/attach.js')
    const project = await readProject(workspaceRoot, projectId)
    if (trackFamily(project, trackName).length === 0) return
    if (args.replace === true) {
      const removed = removeTrackFamily(project, trackName)
      await saveProject(workspaceRoot, project, { by: 'agent', note: `替换音效：移除旧轨道 ${removed.join('、')}` })
      layoutNotes.push(`replace: removed the previous ${removed.join('、')} before adding this batch.`)
    } else {
      layoutNotes.push(
        `this project already had ${trackName}; this call APPENDED to it rather than replacing. `
        + 'If the batch was meant to replace the old one, pass replace:true next time, or remove the old clips with anyaudio_project mode:"update" field:"delete".',
      )
    }
  }

  for (const [index, item] of items.entries()) {
    const gainDb = Number.isFinite(Number(item.gainDb)) ? Number(item.gainDb) : 0
    // A library sound is a different source, not a different kind of item: it
    // resolves to one file in an installed pack, that file is converted into the
    // project once, and every placement after that reuses the same material.
    if (item.sound !== undefined) {
      const wanted = String(item.sound)
      // `freesound/<id>` is the online source. It is addressed the same way a
      // pack sound is, so the agent has one syntax to remember and the search
      // results can print the exact string to pass back.
      if (wanted.startsWith('freesound/')) {
        const soundId = Number(wanted.slice('freesound/'.length))
        if (!Number.isFinite(soundId) || soundId <= 0) {
          throw new Error(`"${wanted}" is not an online sound id; write it as "freesound/<id>"`)
        }
        const category = '其他'
        const wantedStart = Number(item.startSec ?? item.start ?? args.startSec)
        const wantedTrackName = item.trackName || args.trackName || `音效 · ${category}`
        await prepareFamily(wantedTrackName)
        const cached = await downloadPreview({ soundId, previewUrl: item.previewUrl })
        const attached = await attachMaterialFile(workspaceRoot, projectId, null, {
          remote: {
            sound: {
              soundId,
              title: item.title ?? '',
              author: item.author ?? '',
              pageUrl: item.pageUrl ?? `https://freesound.org/s/${soundId}/`,
            },
            previewPath: cached.path,
          },
          trackName: wantedTrackName,
          category: 'other',
          label: item.title || `freesound/${soundId}`,
          startSec: Number.isFinite(wantedStart) ? Number(wantedStart) : undefined,
          autoStart: !Number.isFinite(wantedStart),
          inSec: Number.isFinite(Number(item.inSec)) ? Number(item.inSec) : undefined,
          outSec: Number.isFinite(Number(item.outSec ?? item.durationSec)) ? Number(item.outSec ?? item.durationSec) : undefined,
          gainDb,
          pan: Number.isFinite(Number(item.pan)) ? Number(item.pan) : 0,
          fadeInSec: Number.isFinite(Number(item.fadeInSec)) ? Number(item.fadeInSec) : 0,
          fadeOutSec: Number.isFinite(Number(item.fadeOutSec)) ? Number(item.fadeOutSec) : 0,
          findFfmpeg,
        })
        const projectCopy = join(projectDir(workspaceRoot, projectId), attached.file)
        materials.push({
          file: relativeToWorkspace(workspaceRoot, projectCopy),
          absolutePath: projectCopy,
          category,
          durationSec: Number(attached.durationSec.toFixed(3)),
          // A silent file measures as null; the schema wants a number, and -120 is
          // the value the rest of the plugin already uses for "nothing there".
          peakDb: attached.peakDb === null ? -120 : attached.peakDb,
          rmsDb: attached.rmsDb === null ? -120 : attached.rmsDb,
          sound: `freesound/${soundId}`,
          remote: true,
          gainDb,
          attached,
        })
        continue
      }
      const { packs } = await listPacks()
      const { sound, pack } = resolveSound(packs, item.sound)
      const category = LIBRARY_TYPE_LABEL[sound.type] ?? '其他'
      const wantedStart = Number(item.startSec ?? item.start ?? args.startSec)
      const wantedTrackName = item.trackName || args.trackName || `音效 · ${category}`
      await prepareFamily(wantedTrackName)
      // `durationSec` on a library item is the clip's length, not a rewrite of
      // the file: the material is a copy of a real recording, and re-encoding it
      // to a different length would both lose the original and turn one sound
      // into several materials. Trimming is what `outSec` is for, so the two are
      // the same thing here and the shorter of them wins.
      const wantedLength = Number(item.outSec ?? item.durationSec ?? item.duration)
      const attached = await attachMaterialFile(workspaceRoot, projectId, null, {
        library: { sound, packDir: pack.dir },
        trackName: wantedTrackName,
        category: LIBRARY_TYPE_CATEGORY[sound.type] ?? 'other',
        label: sound.name,
        startSec: Number.isFinite(wantedStart) ? Number(wantedStart) : undefined,
        autoStart: !Number.isFinite(wantedStart),
        // Everything below is a clip property, never a rewrite of the material:
        // the same sound placed three times at three gains is still one file.
        inSec: Number.isFinite(Number(item.inSec)) ? Number(item.inSec) : undefined,
        outSec: Number.isFinite(wantedLength) && wantedLength > 0 ? wantedLength : undefined,
        gainDb,
        pan: Number.isFinite(Number(item.pan)) ? Number(item.pan) : 0,
        fadeInSec: Number.isFinite(Number(item.fadeInSec)) ? Number(item.fadeInSec) : 0,
        fadeOutSec: Number.isFinite(Number(item.fadeOutSec)) ? Number(item.fadeOutSec) : 0,
        findFfmpeg,
      })
      if (Number.isFinite(wantedLength) && wantedLength > sound.durationSec + 1e-6) {
        layoutNotes.push(
          `"${sound.name}" lasts ${sound.durationSec.toFixed(2)}s; the clip uses the whole sound instead of padding it with silence`,
        )
      }
      const projectCopy = join(projectDir(workspaceRoot, projectId), attached.file)
      materials.push({
        file: relativeToWorkspace(workspaceRoot, projectCopy),
        absolutePath: projectCopy,
        category,
        durationSec: Number(attached.durationSec.toFixed(3)),
        peakDb: attached.peakDb === null ? -120 : attached.peakDb,
        rmsDb: attached.rmsDb === null ? -120 : attached.rmsDb,
        sound: `${sound.packId}/${sound.name}`,
        packId: sound.packId,
        soundName: sound.name,
        type: sound.type,
        gainDb,
        attached,
      })
      continue
    }
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
    // asked. Without an explicit start it follows the last clip of its category
    // instead of landing at 0s: ten effects stacked on the same instant are ten
    // tracks, which is how a batch used to run the project into the 20-track
    // limit. Effects that never overlap still share a track (spec §5.2), because
    // an effect overlapping another one is an error, not an arrangement choice.
    const wantedStart = Number(item.startSec ?? item.start ?? args.startSec)
    const wantedTrackName = item.trackName || args.trackName || `音效 · ${category}`
    await prepareFamily(wantedTrackName)
    // The level is measured here for the reply. It goes into the index too, so a
    // person asking a week later — or the clip bay's own meter — reads the same
    // number instead of re-reading the file (improvement plan 03, I-36).
    const peakDb = Number(toDb(peakOf(channels)).toFixed(2))
    const rmsDb = Number(toDb(rmsOf(channels)).toFixed(3))
    const attached = await attachMaterialFile(workspaceRoot, projectId, written.path, {
      kind: category === '环境音' ? 'ambience' : 'sfx',
      trackName: wantedTrackName,
      category: SFX_TRACK_CATEGORY[category] ?? 'other',
      snapshot: entry ? { preset: entry.id, durationSec: lengthSec, gainDb } : { type: item.type ?? item.name, params: item.params ?? {}, seed: Number.isFinite(Number(item.seed)) ? Number(item.seed) : undefined, durationSec: lengthSec, gainDb },
      snapshotKind: 'sfx',
      tool: 'anyaudio_sfx',
      label,
      startSec: Number.isFinite(wantedStart) ? Number(wantedStart) : undefined,
      autoStart: !Number.isFinite(wantedStart),
      peakDb,
      rmsDb,
    })
    // The project's copy is what the clip bay plays and what the reply has to
    // name: the scratch file is removed once the batch is done.
    const projectCopy = join(projectDir(workspaceRoot, projectId), attached.file)
    materials.push({
      file: relativeToWorkspace(workspaceRoot, projectCopy),
      absolutePath: projectCopy,
      category,
      durationSec: Number(lengthSec.toFixed(3)),
      peakDb,
      rmsDb,
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
  const warnings = [...calibration.filter((item) => item.note).map((item) => item.note), ...layoutNotes]
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

  // Only a delivered copy is a deliverable; the scratch folder exists so the
  // project can take its copy and the manifest can be handed over, then it goes.
  await rm(directory, { recursive: true, force: true })
  return {
    ok: true,
    projectId,
    mode: 'materials',
    ...(deliveredDir
      ? {
          deliveredDirectory: relativeToWorkspace(workspaceRoot, deliveredDir),
          deliveredDirectoryAbsolutePath: deliveredDir,
          manifest: relativeToWorkspace(workspaceRoot, join(deliveredDir, 'manifest.json')),
        }
      : {}),
    sampleRate,
    materials,
    calibration,
    warnings,
  }
}

/**
 * The library half of `catalog`.
 *
 * A priority pack is expanded to its names, grouped by type, because those are
 * the names the agent is expected to pick from without another call. A normal
 * pack is one line: its names are reachable through `search`, and expanding a
 * 446-entry pack here would cost more context than the whole preset catalog.
 */
async function libraryCatalog(config) {
  const { packs, warnings } = await listPacks()
  const rows = []
  for (const pack of packs) {
    const priority = isPriorityPack(config.sfx?.packs, pack.id)
    const groups = {}
    for (const sound of pack.sounds) {
      if (!groups[sound.type]) groups[sound.type] = []
      groups[sound.type].push(sound.name)
    }
    rows.push({
      id: pack.id,
      name: pack.name,
      priority,
      count: pack.sounds.length,
      groups: priority ? groups : {},
      dir: pack.dir,
    })
  }
  // Priority packs first, then the rest, each in directory order.
  rows.sort((a, b) => Number(b.priority) - Number(a.priority))
  return { packs: rows, warnings }
}

/** The `inspect` action: the fields of a few named sounds, and a picture of each. */
async function inspectSounds(names, { exec, withImages }) {
  const { packs, warnings } = await listPacks()
  const sounds = []
  const ffmpeg = withImages ? findFfmpeg() : null
  // Three pictures is the ceiling: each 1024×256 image costs about 191 tokens on
  // DeepSeek, and a fourth would start pushing the request toward the host's
  // image budget, where the whole turn loses its pictures instead of one.
  const pictureBudget = 3
  let pictures = 0
  for (const name of names) {
    const { sound, pack } = resolveSound(packs, name)
    const row = {
      name: sound.name,
      packId: sound.packId,
      type: sound.type,
      durationSec: Number(sound.durationSec.toFixed(3)),
      ...(sound.peakPosSec === undefined ? {} : { peakPosSec: Number(sound.peakPosSec.toFixed(3)) }),
      file: sound.file,
    }
    // Ambience is chosen by scene and meaning, not by shape: its envelope is
    // nearly flat, so a picture of it carries almost no signal (measured: 1.83 dB
    // of envelope variation against 15.76 dB for foley).
    if (withImages && ffmpeg && attachmentService && pictures < pictureBudget && sound.type !== 'ambience') {
      try {
        const samples = await decodeMonoSamples(ffmpeg.command, join(pack.dir, sound.file), { signal: exec?.signal })
        const png = drawWaveform({ samples })
        const ref = await attachmentService.saveImage({
          data: png,
          mediaType: 'image/png',
          name: `${sound.name}.png`,
        })
        row.image = ref
        pictures++
      } catch (error) {
        warnings.push(`no waveform for "${sound.name}": ${error.message}`)
      }
    }
    sounds.push(row)
  }
  return { sounds, warnings, pictures }
}

function renderText(args, value) {
      if (value.action === 'catalog') {
        const lines = []
        // The library comes first: it is the source the agent is expected to use,
        // and the presets below it are the fallback.
        for (const pack of value.library ?? []) {
          if (pack.priority) {
            lines.push(`${pack.name} ${pack.id}（优先，${pack.count} 条）`)
            for (const [type, names] of Object.entries(pack.groups ?? {})) {
              lines.push(`【${LIBRARY_TYPE_LABEL[type] ?? type} ${names.length}】`)
              lines.push(...names)
            }
            lines.push('')
          } else {
            lines.push(`${pack.name} ${pack.id}（普通，${pack.count} 条）—— 需要时用 action:"search" 检索`)
          }
        }
        if ((value.library ?? []).length > 0) lines.push('')
        else {
          // An empty library is not a dead end: the person can install the
          // recommended pack, and saying so is more useful than silently
          // dropping to the presets.
          lines.push('还没有安装任何音效包。让用户到「设置 → AnyAudio → 音效」装一个（推荐的基础音效包 BaseSFX 在那里有下载地址）。')
          lines.push('')
        }
        for (const warning of value.libraryWarnings ?? []) lines.push(`! ${warning}`)
        if ((value.libraryWarnings ?? []).length > 0) lines.push('')

        lines.push('--- 以下为 SoundFont 内置采样（兜底）---')
        lines.push(`Sound-effect presets in the default banks: ${value.presets.length} (installed: ${value.installed.join(', ') || 'none'})`)
        lines.push('Groups: ' + value.groups.map((entry) => `${entry.id} (${entry.label})`).join(', '))
        lines.push('Use {items:[{preset:"rain", startSec:0, durationSec:20}]} to place them; durationSec is optional (sustained presets hold, one-shots play their natural tail).')
        lines.push('')
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
      if (value.action === 'inspect') {
        const lines = value.sounds.map((sound) => {
          const peak = sound.peakPosSec === undefined ? '' : ` | 主峰 ${sound.peakPosSec.toFixed(3)}s`
          return `${sound.name} | ${LIBRARY_TYPE_LABEL[sound.type] ?? sound.type} | ${sound.durationSec.toFixed(2)}s${peak}`
        })
        for (const warning of value.warnings ?? []) lines.push(`! ${warning}`)
        return lines.join('\n')
      }
      if (value.action === 'search') {
        const lines = []
        if (value.total === 0) {
          lines.push(`库里没有匹配的名字："${value.query}"`)
          if (value.packCount === 0) lines.push('还没有安装任何音效包。让用户到「设置 → AnyAudio → 音效」装一个（推荐的基础音效包 BaseSFX 在那里有下载地址）。')
        } else {
          lines.push(...value.results.map((entry) => {
            const mark = entry.priority ? '（优先）' : ''
            return `${entry.name}${mark} | ${LIBRARY_TYPE_LABEL[entry.type] ?? entry.type} | ${entry.durationSec.toFixed(2)}s | ${entry.packId}`
          }))
          if (value.truncated) lines.push(`共 ${value.total} 条，显示前 ${value.shown} 条；换更具体的词可以缩小范围`)
        }
        if (value.remote) {
          lines.push('', `线上 CC0（Freesound，共 ${value.remote.total} 条）—— 取用时把 previewUrl 一起传回：`)
          lines.push(...value.remote.results.map((entry) => {
            const seconds = entry.durationSec === null ? '?' : entry.durationSec.toFixed(2)
            const downloads = entry.downloads === null ? '' : ` · ${entry.downloads} 次下载`
            return `${entry.name} | ${seconds}s | ${entry.title} · ${entry.author}${downloads}\n  previewUrl: ${entry.previewUrl}`
          }))
        }
        for (const warning of value.warnings ?? []) lines.push(`! ${warning}`)
        return lines.join('\n')
      }
      if (value.mode === 'materials') {
        const lines = [
          `Wrote ${value.materials.length} sound material(s) into project ${value.projectId}${value.deliveredDirectory ? `; a delivered copy is in ${value.deliveredDirectory}` : ''}`,
          'Materials (each starts at t=0):',
          ...value.materials.map((entry) => `- ${entry.file} · ${entry.category} · ${entry.durationSec.toFixed(2)}s · peak ${entry.peakDb.toFixed(1)} dBFS${entry.attached ? ` → track "${entry.attached.trackName}" @ ${Number(entry.attached.startSec).toFixed(2)}s` : ''}`),
          `In project ${value.projectId}: each effect is its own clip, so one can be moved or dropped without re-rendering the others.`,
          ...(value.warnings ?? []).map((warning) => `! ${warning}`),
        ]
        return lines.join('\n')
      }
      return `Wrote ${value.materials?.length ?? 0} sound material(s) in project ${value.projectId}.`
}

export const sfxToolDefinition = finalizeTool({
  name: 'anyaudio_sfx',
  description:
    'Add sound effects to a clip bay project, so the person can open, hear and move them. ' +
    'Three sources, in this order: ' +
    '① the installed sound library — {sound:"门-木门-敲门-三下-中等"}; run action:"catalog" to see the names of the priority packs, and action:"search" to find one in the others; ' +
    '② online CC0 — when the library has nothing, action:"search" also looks at Freesound and returns {sound:"freesound/<id>"} plus the previewUrl to pass back; that site is English, so search it with English words (spaceship landing, not 飞船降落); ' +
    '③ SoundFont presets — {preset:"rain"} or {preset:"gun-shot"} (birds, seashore, wind, door, car, applause, explosion …); ' +
    '④ procedural generators — {type:"wind"} etc. (wind, rain, water, fire, birds, footsteps, stones, whoosh, impact, bell, gong, drum, riser, heartbeat, thunder). ' +
    'One name is one recording, and it may already contain several hits: 门-木门-敲门-三下 is three knocks. To make a sound denser or longer, place several clips offset in time — do not look for a "five knocks" entry, the library has none and should not. ' +
    'You decide how each clip is used: trim it with inSec/outSec, overlap two clips with fades, set gainDb and pan. The tool never splits a recording on its own (detecting hits is unreliable), but it does exactly what you ask. ' +
    'Every effect becomes its own clip; the clips are placed on the project timeline as they are created — pass startSec to say where, or leave it out and each effect follows the previous one on its own track. ' +
    'It needs projectId; a copy of every file is kept under the project folder. ' +
    'Music itself comes from anyaudio_music; narration from anyaudio_tts. ' +
    'Every effect stays an editable clip: this tool never bakes effects together, and there is no flat-bed mode.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: "Omit to place items. \"catalog\" lists the priority packs' sound names plus the SoundFont presets; \"search\" finds a name in every installed pack; \"inspect\" returns the fields of a few named sounds." },
      projectId: { type: 'string', description: 'The clip bay project these effects belong to. Required whenever you pass items: run anyaudio_project mode:"create" first when the task has no project yet. The read-only actions do not need it.' },
      trackName: { type: 'string', description: 'Track name, default 音效 · <类别>. Effects that never overlap in time share one track; overlapping ones move to the next free track automatically. Everything in one call lands on its own category track.' },
      startSec: { type: 'number', description: 'Where an effect sits on the project timeline. Omitted, each effect starts right after the previous one on the same track, so a batch laid down in order plays back to back instead of stacking at 0s. An item may set its own startSec.' },
      mode: { type: 'string', enum: ['materials'], description: 'Kept for compatibility; "materials" is the only mode, and it is the default. Each effect becomes its own clip, which is what makes it adjustable.' },
      items: { oneOf: [{ type: 'array', items: { type: 'object', additionalProperties: true } }, { type: 'string' }], description: 'SFX events. Each item names one source: {sound:"library name"} or {preset:"rain"} or {type:"wind"}. Optional per item: startSec, gainDb, pan, fadeInSec, fadeOutSec, and for a library sound inSec/outSec to use only part of the recording. A library sound needs no durationSec (it has its own length); a procedural type does. A path to a .json file holding the array is also accepted.' },
      output: { type: 'string', description: "Optional extra copy of the delivered files: the folder that receives one file per item plus manifest.json. Relative paths resolve against the user's project. The project's own copies are always written under the project folder." },
      durationSec: { type: 'number', description: 'Fallback length for an item that names none. A preset with its own natural tail does not need it; a procedural generator does. A library sound never needs it.' },
      sampleRate: { type: 'number', description: 'Sample rate, default 48000.' },
      peakDb: { type: 'number', description: 'Ignored, with a warning: normalising each file separately would change the relative balance between effects. Set each item\'s gainDb instead, or adjust the clip gain in the project.' },
      group: { type: 'string', description: 'Catalog filter: noise, weather, animals, home, traffic, crowd or weapons.' },
      query: {
        type: 'string',
        description: 'For action:"search": the text to look for inside sound names. A name that contains it is a hit, wherever it sits. '
          + 'Use short words, not sentences: search 敲门, not 用力敲门; search 雨, not 雨声 (a name may say 小雨, which does not contain 雨声). '
          + 'Run 3–5 words from different dimensions in parallel — what it sounds like, the object, the action, the material. '
          + 'When nothing hits, change the dimension (action → object → material → result sound), and only then try a synonym. '
          + 'Stop after 3 rounds and move on; do not keep rewording. '
          + 'The online site is English: when the local library has nothing, search it with English words. '
          + 'For action:"catalog": a preset filter.',
      },
      names: { oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }], description: 'For action:"inspect": the sound names to look at (up to 3 get a waveform image).' },
      limit: { type: 'number', description: 'For action:"search": how many names to return, default 30.' },
      remote: { type: 'boolean', description: 'For action:"search": also look online (Freesound CC0) when the local library has no match. On by default; pass false to keep the search local.' },
      type: { type: 'string', description: 'For action:"search": only return sounds of this kind (foley, ambience, dsn).' },
      replace: { type: 'boolean', description: 'Replace instead of append. When this is a second pass over effects the project already holds (you changed levels or swapped presets and are generating again), pass true: the track family these effects land in is cleared first, so the project keeps one set rather than gaining a second. Without it a re-run appends, which is how "音效 · 动效" and "音效 · 动效 2" end up side by side.' },
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
        library: { type: 'array', items: { type: 'object', additionalProperties: true } },
        libraryWarnings: { type: 'array' },
        sounds: { type: 'array', items: { type: 'object', additionalProperties: true } },
        query: { type: 'string' },
        total: { type: 'number' },
        shown: { type: 'number' },
        truncated: { type: 'boolean' },
        results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        packCount: { type: 'number' },
        remote: { type: 'object', additionalProperties: true },
        warnings: { type: 'array' },
      },
    },
    render: (args, value) => {
      // `inspect` is the one action that returns pictures, so it builds its own
      // block array instead of going through `textRenderer`, which can only
      // produce text.
      if (value.action === 'inspect') {
        const blocks = []
        const lines = value.sounds.map((sound) => {
          const peak = sound.peakPosSec === undefined ? '' : ` | 主峰 ${sound.peakPosSec.toFixed(3)}s`
          return `${sound.name} | ${LIBRARY_TYPE_LABEL[sound.type] ?? sound.type} | ${sound.durationSec.toFixed(2)}s${peak}`
        })
        for (const warning of value.warnings ?? []) lines.push(`! ${warning}`)
        blocks.push({ type: 'text', text: lines.join('\n') })
        for (const sound of value.sounds) {
          if (!sound.image) continue
          blocks.push({ type: 'text', text: `${sound.name} 的波形（横轴是时间，纵轴是振幅）` })
          blocks.push({ type: 'image', attachment: sound.image })
        }
        return blocks
      }
      return textRenderer(renderText)(args, value)
    },
  },
  async execute(args, exec) {
    const workspaceRoot = await workspaceRootOf(exec)
    const { config } = await readConfig()
    const fonts = await listFonts()
    const paths = installedFontPaths(fonts)

    const action = String(args.action ?? '').toLowerCase()

    if (action === 'catalog') {
      const presets = listSfxPresets({ fonts: [...paths.keys()], group: args.group, query: args.query })
      const calibration = []
      for (const fontId of SFX_FONTS) {
        const fontPath = paths.get(fontId)
        if (fontPath) calibration.push(await fontCalibration(fontId, fontPath))
      }
      const library = await libraryCatalog(config)
      return {
        ok: true,
        action: 'catalog',
        library: library.packs,
        libraryWarnings: library.warnings,
        groups: Object.entries(SFX_GROUPS).map(([id, label]) => ({ id, label })),
        presets: presets.map((entry) => ({ ...entry, note: entry.note, installed: paths.has(entry.font) })),
        installed: [...paths.keys()],
        calibration,
      }
    }

    if (action === 'inspect') {
      const names = Array.isArray(args.names) ? args.names : await readJsonParam(args.names, 'names', { workspaceRoot })
      if (!Array.isArray(names) || names.length === 0) throw new Error('action:"inspect" needs names: an array of sound names (or a path to a .json file holding one)')
      const withImages = await modelSeesImages(exec)
      const inspected = await inspectSounds(names, { exec, withImages })
      return { ok: true, action: 'inspect', sounds: inspected.sounds, warnings: inspected.warnings }
    }

    if (action === 'search') {
      const { packs, warnings } = await listPacks()
      const found = searchLibrary(packs, {
        query: args.query,
        type: args.type,
        limit: args.limit,
        packsConfig: config.sfx?.packs,
      })
      // The online source is the second of three, so it is only consulted when
      // the local library has nothing. A search that already found the sound
      // does not need a network round-trip, and a search that cannot reach the
      // network still answers with what the local packs hold.
      let remote = null
      if (found.total === 0 && args.remote !== false) {
        const online = await searchFreesound(args.query, { limit: args.limit ?? 10 })
        if (online.results.length > 0) {
          remote = {
            results: online.results.map((entry) => ({
              ...entry,
              name: `freesound/${entry.soundId}`,
              packId: 'freesound',
              type: null,
              priority: false,
            })),
            total: online.total,
            error: online.error,
          }
        } else if (online.error) {
          warnings.push(online.error)
        }
      }
      // `remote` is omitted rather than set to null: the output schema declares it
      // as an object, and a null there fails the whole tool result.
      return { ok: true, action: 'search', ...found, packCount: packs.length, ...(remote ? { remote } : {}), warnings }
    }

    const items = Array.isArray(args.items) ? args.items : await readJsonParam(args.items, 'items', { workspaceRoot })
    if (!Array.isArray(items) || items.length === 0) throw new Error('items must be a non-empty array (or use action:"catalog", "search" or "inspect")')
    const projectId = requireProjectId(args, 'anyaudio_sfx')
    // "timeline" mode used to bake every effect into one full-length clip, so
    // nothing on it could be moved, faded or rebalanced — the exact thing a clip
    // bay exists to prevent. It is gone; say where the alternative is instead of
    // failing on an unknown enum.
    if (String(args.mode ?? '').toLowerCase() === 'timeline') {
      throw new Error(
        '"timeline" mode was removed: it baked every effect into one clip, so nothing on it could be adjusted. '
        + 'Use mode:"materials" — each effect becomes its own clip you can move, fade and rebalance.',
      )
    }
    if (args.mode !== undefined && String(args.mode).toLowerCase() !== 'materials') {
      throw new Error(`unknown mode "${args.mode}"; "materials" is the only mode`)
    }
    return renderMaterials(args, projectId, items, { workspaceRoot, config, paths })
  },
})

export function registerSfxTool(ctx) {
  ctx.tools.register(sfxToolDefinition)
}
