/**
 * `anyaudio_project` — the Agent's door into the clip bay (plan M6).
 *
 * Modes:
 *   create        make a project skeleton in this workspace, return its id
 *   add_material  move a generated file into the project, register it, and place
 *                 it on a track (creating the track when needed)
 *   read          the whole project as JSON, so the Agent can see the arrangement
 *   update        change fields on tracks and clips by stable id
 *   render        mix the project down to a file
 *
 * `create` and `add_material` are what make the chain work: without them the
 * Agent generates files and a person has to drag them in by hand. Everything the
 * Agent writes appends a `by:"agent"` history entry, which is what lets the user
 * see what changed and is why the clip bay refuses to undo those edits.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { contentEndSec, LIMITS, TRACK_CATEGORIES, MATERIAL_KINDS, validateFxChain } from '../project/schema.js'
import { createProject, listProjects, readDraft, readMaterialIndex, readProject, saveProject, writeMaterialIndex } from '../project/store.js'
import { ensureMaterialLevels, findMaterial, registerMaterial, deleteMaterial, referencesFor } from '../project/materials.js'
import { importFile, importGeneratedMaterial } from '../project/import.js'
import { exportProject, renderProject } from '../project/render.js'
import { ensureTrack, placeClip } from '../project/attach.js'
import { projectDir, resolveInside } from '../project/paths.js'
import { findFfmpeg, finalizeTool, nowStamp, outputDir, relativeToWorkspace, resolveOutputPath, textBlocks, textRenderer, workspaceRootOf } from './shared.js'
import { readConfig } from '../config.js'
import { providerInfo, voiceDisplayName } from '../audio/tts-providers.js'

const MODES = ['create', 'add_material', 'read', 'update', 'render']

/**
 * The narration engine and voice the person picked in Settings → AnyAudio.
 *
 * It has to reach the Agent *before* it calls anyaudio_tts, because the value is
 * invisible otherwise: no tool returns it, and an Agent that cannot see the
 * configured engine has to guess. In the session that prompted this it reasoned
 * "用户配置的默认引擎未知", passed provider:"edge" for control, and silently
 * overrode a MiMo setting (improvement plan 04).
 */
function narrationDefault(config) {
  const provider = String(config?.tts?.provider ?? 'edge').trim() || 'edge'
  const info = providerInfo(provider)
  const voice = String(config?.tts?.[provider]?.voice ?? info?.voices?.[0] ?? '').trim()
  if (!info) return null
  return {
    provider,
    label: info.label,
    voice: voiceDisplayName(voice) ?? voice,
    voiceId: voice,
  }
}

function requireWorkspace(exec) {
  return workspaceRootOf(exec).then((root) => {
    if (!root) throw new Error('no workspace folder is open; open one before using the clip bay')
    return root
  })
}


/**
 * Give every material in the index a measured level, and write back the ones
 * that had none.
 *
 * A material's loudness is a fact about the file, so it belongs in the file's
 * record next to its length (improvement plan 03, I-37). Materials registered
 * before this existed have no level, and re-importing them is not an option —
 * an external file cannot be re-rendered at all. Measuring on read costs one
 * pass over the samples, the same cost the peaks file already pays, and it makes
 * every older project answer the question "how loud is this" from then on.
 *
 * A file that has gone missing keeps `null` instead of failing the read: the
 * project still describes an arrangement, and mode:"read" is how a person finds
 * out what is wrong with it.
 */
async function measureMissingLevels(workspaceRoot, project, index) {
  return ensureMaterialLevels(workspaceRoot, project.id, index)
}


async function projectSummary(workspaceRoot, project) {
  // Levels are measured on demand so an older project answers "how loud is this"
  // from then on (improvement plan 03, I-37). The measuring lives in the material
  // module because the clip bay's own read route needs exactly the same pass.
  const index = await ensureMaterialLevels(workspaceRoot, project.id, await readMaterialIndex(workspaceRoot, project.id))
  // The clip bay's unsaved work is not part of this arrangement (improvement
  // plan 05). Saying so keeps the Agent from "fixing" a state the person is
  // still auditioning, and from being surprised when the panel saves over it.
  const draft = await readDraft(workspaceRoot, project.id).catch(() => null)
  return {
    projectId: project.id,
    name: project.name,
    durationSec: contentEndSec(project),
    ...(draft ? { draft: true } : {}),
    folder: relativeToWorkspace(workspaceRoot, projectDir(workspaceRoot, project.id)),
    masterFaderDb: project.masterFaderDb,
    ...(project.masterFx?.length ? { masterFx: project.masterFx } : {}),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      category: track.category,
      muted: track.muted,
      solo: track.solo,
      clips: track.items.map((item) => ({
        id: item.id,
        material: item.material,
        label: item.label,
        startSec: item.startSec,
        inSec: item.inSec,
        outSec: item.outSec,
        gainDb: item.gainDb,
        pan: item.pan,
        fadeInSec: item.fadeInSec,
        fadeOutSec: item.fadeOutSec,
        muted: item.muted,
        // Effects are reported on the level they belong to, so "where does this
        // EQ live" is answered by the shape of the value rather than by asking.
        ...(item.fx?.length ? { fx: item.fx } : {}),
      })),
    })),
    materials: index.materials.map((material) => ({
      id: material.id,
      kind: material.kind,
      file: material.file,
      durationSec: material.durationSec,
      // A material's measured level is the ledger every mix decision reads
      // (improvement plan 03, I-37). `null` means nobody has measured it yet —
      // it must never read as 0 dB, which would be a claim about the file.
      peakDb: material.peakDb ?? null,
      rmsDb: material.rmsDb ?? null,
      // How many clips point at it — 0 means it is an orphan, and orphans were
      // 398 MB of one real project with no way to see them (I-40).
      referencedBy: referencesFor(project, material.id).length,
      source: material.source?.tool ?? material.source?.kind ?? 'unknown',
    })),
    video: project.video ?? null,
  }
}

/**
 * Apply one field change to a project, a track or a clip, addressed by id. Kept
 * deliberately narrow: the Agent names a field and a value, and this refuses what
 * the schema would reject rather than writing a project the clip bay cannot open.
 *
 * `target:"project"` exists because the fields were there and unreachable: the
 * bus fader lives in project.json, so an Agent asked to change the master level
 * could only guess a track field, which is what happened ("unknown track field
 * masterFaderDb"). `normalizeGainDb` stays closed on purpose — it is measured by
 * the renderer on the first export and frozen (spec §10.2), so letting it be set
 * by hand would break "measured once, then fixed".
 */
function applyUpdate(project, { target, trackId, clipId, field, value }) {
  if (target === 'project') {
    switch (field) {
      case 'name': project.name = String(value).trim().slice(0, 80); return `重命名工程「${project.name}」`
      case 'masterFaderDb': project.masterFaderDb = Number(value); return `调整总线音量 ${project.masterFaderDb} dB`
      case 'masterFx': {
        project.masterFx = validateFxChain(value, 'masterFx')
        return `设置总线效果链（${describeChain(project.masterFx)}）`
      }
      case 'normalizeGainDb':
        throw new Error(
          'project field "normalizeGainDb" is measured by the renderer, not set: it is fixed the first time the project is exported (spec §10.2), '
          + 'so a manual value would be overwritten anyway. Adjust the mix with masterFaderDb or a clip gainDb instead.',
        )
      default: throw new Error(`unknown project field "${field}"; use name, masterFaderDb or masterFx`)
    }
  }

  // A clip's id is unique across the whole project (`newId('itm')` in the client,
  // and the host mints the same way), so `target:"clip"` does not need a track id
  // at all. It used to require one and then look it up with `undefined`, which
  // failed as "no such track: undefined" — an Agent in a real session sent eight
  // clip changes without a trackId and lost all eight, then kept retrying the
  // same call because the message said the id was wrong.
  let resolvedTrackId = trackId
  if (target === 'clip' && (resolvedTrackId === undefined || resolvedTrackId === null || resolvedTrackId === '')) {
    const owner = project.tracks.find((entry) => entry.items?.some((item) => item.id === clipId))
    if (owner) resolvedTrackId = owner.id
  }

  const track = project.tracks.find((entry) => entry.id === resolvedTrackId)
  if (!track) {
    if (target === 'clip' && !resolvedTrackId) {
      const known = project.tracks
        .flatMap((entry) => (entry.items ?? []).map((item) => `${item.id} "${item.label || ''}"`))
        .join(', ')
      throw new Error(
        `no such clip: ${clipId}. ${known ? `This project has: ${known}` : 'This project has no clips yet'}. `
        + 'For a clip, pass target:"clip" with clipId — trackId is optional and is worked out from the clip id.',
      )
    }
    // An id that exists, but as a clip, is a mistake worth naming. The agent in
    // the session that prompted this passed `itm_oqpdqa` as a trackId and got
    // back "no such track", which says nothing about what to do next — it
    // retried with the same value. A message that names the confusion ends it.
    const owner = project.tracks.find((entry) => entry.items?.some((item) => item.id === resolvedTrackId))
    if (owner) {
      const item = owner.items.find((entry) => entry.id === resolvedTrackId)
      throw new Error(
        `"${resolvedTrackId}" is a clip id, not a track id: it belongs to clip "${item?.label || resolvedTrackId}" on track "${owner.name}" (${owner.id}). `
        + 'For a clip, set target:"clip" and pass trackId plus clipId; for the track itself use target:"track" with the track id. '
        + 'mode:"read" lists both ids for every track.',
      )
    }
    const ids = project.tracks.map((entry) => `${entry.id} "${entry.name}"`).join(', ')
    throw new Error(`no such track: ${resolvedTrackId}. This project tracks: ${ids || '(none)'}`)
  }

  if (target === 'track') {
    switch (field) {
      case 'name': track.name = String(value).slice(0, 80); return `重命名轨道「${track.name}」`
      case 'muted': {
        track.muted = Boolean(value)
        // Same rule as the clip bay's own buttons: mute wins over solo in
        // `resolveTrackGain`, so a track that is both is silent while every other
        // track is silenced by the solo — the whole project goes quiet and the
        // caller has no way to tell. Clearing the other flag keeps the two
        // properties meaning what their names say.
        const cleared = track.muted && track.solo === true
        if (cleared) track.solo = false
        return `${track.muted ? '静音' : '取消静音'}轨道「${track.name}」${cleared ? '（同时取消独奏）' : ''}`
      }
      case 'solo': {
        track.solo = Boolean(value)
        const cleared = track.solo && track.muted === true
        if (cleared) track.muted = false
        return `${track.solo ? '独奏' : '取消独奏'}轨道「${track.name}」${cleared ? '（同时取消静音）' : ''}`
      }
      case 'delete': {
        // Deleting a track is how a person cleans up after a re-render that
        // appended a second copy instead of replacing the first. Without it the
        // only way out was to start a new project — which is what turned one
        // bad call into four projects in the session that prompted this.
        const count = track.items.length
        project.tracks = project.tracks.filter((entry) => entry.id !== trackId)
        return count > 0
          ? `删除轨道「${track.name}」及其 ${count} 个片段`
          : `删除轨道「${track.name}」`
      }
      default: throw new Error(
        `unknown track field "${field}"; a track is a grouping and has only name, muted, solo or delete. `
        + 'Volume, pan and effects live on each clip (target:"clip", field:"gainDb"/"pan"/"fx"), so one update with many changes does the same job for a whole track.',
      )
    }
  }

  const clip = track.items.find((entry) => entry.id === clipId)
  if (!clip) {
    const ids = track.items.map((item) => `${item.id} "${item.label || ''}"`).join(', ')
    throw new Error(`no such clip: ${clipId}. Track "${track.name}" has: ${ids || '(no clips on it)'}`)
  }
  if (field === 'delete') {
    track.items = track.items.filter((entry) => entry.id !== clipId)
    return `删除片段「${clip.label || clip.id}」（轨道「${track.name}」）`
  }

  switch (field) {
    case 'startSec': clip.startSec = Number(value); break
    case 'inSec': clip.inSec = Number(value); break
    case 'outSec': clip.outSec = Number(value); break
    case 'gainDb': clip.gainDb = Number(value); break
    case 'pan': clip.pan = Number(value); break
    case 'fadeInSec': clip.fadeInSec = Number(value); break
    case 'fadeOutSec': clip.fadeOutSec = Number(value); break
    case 'muted': clip.muted = Boolean(value); break
    case 'label': clip.label = String(value).slice(0, 120); break
    case 'fx': {
      clip.fx = validateFxChain(value, 'fx')
      return `设置片段「${clip.label || clip.id}」效果链（${describeChain(clip.fx)}）`
    }
    default: throw new Error(`unknown clip field "${field}"; use startSec, inSec, outSec, gainDb, pan, fadeInSec, fadeOutSec, muted, label or fx`)
  }
  return `调整片段「${clip.label || clip.id}」的 ${field}`
}

/** A chain as the history line reads it: "eq → compressor", or "空". */
function describeChain(chain) {
  if (!chain?.length) return '空'
  return chain.map((fx) => fx.type).join(' → ')
}

async function runCreate(workspaceRoot, args) {
  const project = await createProject(workspaceRoot, {
    name: args.name,
    sampleRate: Number(args.sampleRate) || 48000,
    by: 'agent',
    note: args.note || '创建工程',
  })
  const { config } = await readConfig()
  return {
    ok: true,
    mode: 'create',
    ...(await projectSummary(workspaceRoot, project)),
    narration: narrationDefault(config),
  }
}

async function runAddMaterial(workspaceRoot, args, exec) {
  const project = await readProject(workspaceRoot, args.projectId)
  const sourcePath = isAbsolute(args.sourcePath) ? args.sourcePath : resolve(workspaceRoot, String(args.sourcePath ?? ''))
  if (!args.sourcePath) throw new Error('sourcePath is required')

  const kind = MATERIAL_KINDS.includes(args.kind) ? args.kind : 'imported'
  const before = new Set((await readMaterialIndex(workspaceRoot, project.id)).materials.map((entry) => entry.id))

  let imported
  try {
    imported = await importFile(workspaceRoot, project.id, sourcePath, {
      findFfmpeg,
      signal: exec?.signal,
    })
  } catch (error) {
    throw new Error(`could not import ${sourcePath}: ${error.message}`)
  }

  const index = await readMaterialIndex(workspaceRoot, project.id)
  const material = index.materials.find((entry) => !before.has(entry.id))

  // A picture with no audio stream produces no material at all. It is still a
  // usable reference picture, so the import succeeded — say so instead of
  // reporting an import that "produced nothing".
  if (!material && imported.silent) {
    const updated = await readProject(workspaceRoot, project.id)
    return {
      ok: true,
      mode: 'add_material',
      material: null,
      clip: null,
      silent: true,
      ...(await projectSummary(workspaceRoot, updated)),
    }
  }
  if (!material) throw new Error('the import produced no material entry')

  // The importer reports what it could tell from the file; the caller knows what
  // the material actually is, so the requested kind wins — except for a picture's
  // own soundtrack, which is a fact of the file rather than a choice.
  if (material.kind !== 'video-audio') {
    material.kind = kind
    await writeMaterialIndex(workspaceRoot, project.id, index)
  }

  // A picture's soundtrack is part of the picture, not an optional extra: it
  // belongs on the timeline the moment the picture arrives. `trackName` still
  // wins when the caller names a track, so an Agent that wants it elsewhere
  // keeps control.
  const trackName = args.trackName || (material.kind === 'video-audio' ? `画面原声 · ${material.source?.originalName ?? material.id}` : null)

  let clip = null
  if (trackName) {
    const reloaded = await readProject(workspaceRoot, project.id)
    const category = args.category
      || (material.kind === 'video-audio' ? 'video-audio' : kind === 'tts' ? 'tts' : kind === 'music' ? 'music' : 'other')
    const track = ensureTrack(reloaded, { name: trackName, category })
    clip = placeClip(track, material, {
      startSec: args.startSec,
      inSec: args.inSec,
      outSec: args.outSec,
      gainDb: args.gainDb,
      pan: args.pan,
      fadeInSec: args.fadeInSec,
      fadeOutSec: args.fadeOutSec,
      label: args.label,
    })
    await saveProject(workspaceRoot, reloaded, { by: 'agent', note: args.note || `导入素材「${clip.label}」到轨道「${track.name}」` })
  }

  const updated = await readProject(workspaceRoot, project.id)
  return {
    ok: true,
    mode: 'add_material',
    material: {
      id: material.id,
      kind: material.kind,
      file: material.file,
      durationSec: material.durationSec,
    },
    clip: clip ? { id: clip.id, trackName, startSec: clip.startSec, inSec: clip.inSec, outSec: clip.outSec } : null,
    ...(await projectSummary(workspaceRoot, updated)),
  }
}

async function runRead(workspaceRoot, args) {
  if (!args.projectId) {
    const rows = await listProjects(workspaceRoot)
    return { ok: true, mode: 'read', projects: rows }
  }
  const project = await readProject(workspaceRoot, args.projectId)
  return { ok: true, mode: 'read', ...(await projectSummary(workspaceRoot, project)) }
}

/**
 * `target:"material"` — the one update that reaches outside project.json.
 *
 * A material is not a field on an arrangement, it is a file plus its record, so
 * deleting one cannot be a field assignment. `deleteMaterial` already refuses to
 * remove something a clip still points at, which is the rule spec §6.5 asks for;
 * what was missing was any way to reach it (improvement plan 03, I-40 — the
 * function was imported and never called, so 398 MB of orphans in one project
 * had neither a door nor a list).
 */
async function applyMaterialUpdate(workspaceRoot, project, { materialId, field }) {
  if (field !== 'delete') {
    throw new Error(`unknown material field "${field}"; the only one is "delete" — a material's audio can never be edited, only removed`)
  }
  const id = typeof materialId === 'string' ? materialId.trim() : ''
  if (!id) throw new Error('target:"material" needs materialId')
  try {
    await deleteMaterial(workspaceRoot, project.id, id)
    return `删除素材「${id}」`
  } catch (error) {
    const index = await readMaterialIndex(workspaceRoot, project.id)
    const known = index.materials.map((entry) => entry.id).join(', ')
    throw new Error(
      `${error.message}. ${known ? `This project holds: ${known}` : 'This project holds no materials'}.`,
    )
  }
}

async function runUpdate(workspaceRoot, args) {
  const project = await readProject(workspaceRoot, args.projectId)
  const notes = []
  for (const change of args.changes ?? []) {
    // Material deletes touch the index and the disk, so they are awaited in
    // order with the rest instead of being handed to the synchronous field
    // setter that every other target uses.
    if (change?.target === 'material') {
      notes.push(await applyMaterialUpdate(workspaceRoot, project, change))
      continue
    }
    notes.push(applyUpdate(project, change))
  }
  if (notes.length === 0) throw new Error('changes must contain at least one edit')

  const end = contentEndSec(project)
  if (end > LIMITS.durationSec) {
    throw new Error(`this edit would make the project ${end.toFixed(1)}s long; the limit is ${LIMITS.durationSec}s`)
  }
  await saveProject(workspaceRoot, project, { by: 'agent', note: args.note || notes.join('；') })
  const updated = await readProject(workspaceRoot, project.id)
  return { ok: true, mode: 'update', applied: notes, ...(await projectSummary(workspaceRoot, updated)) }
}

async function runRender(workspaceRoot, args, exec) {
  const project = await readProject(workspaceRoot, args.projectId)
  const format = args.format || 'wav'
  const config = await readConfig()
  const defaultName = `${project.id}-${nowStamp()}.${format === 'mp4' ? 'mp4' : format}`
  const outputPath = resolveOutputPath({
    workspaceRoot,
    outputDir: config.output?.dir || outputDir(workspaceRoot),
    requested: args.output,
    defaultName,
  })

  const result = await exportProject({
    project,
    workspaceRoot,
    outputPath,
    format,
    signal: exec?.signal,
    // The first export of a draft measures the mix once and writes the number
    // into project.json; later exports reuse it (spec §10.2).
    freezeNormalize: true,
  })
  return {
    ok: true,
    mode: 'render',
    file: outputPath,
    relative: relativeToWorkspace(workspaceRoot, outputPath),
    format,
    durationSec: result.durationSec,
    peakDb: result.peakDb,
    rmsDb: result.rmsDb,
    trackCount: result.trackCount,
    clipCount: result.clipCount,
  }
}

export const projectToolDefinition = finalizeTool({
  name: 'anyaudio_project',
  description:
    'Read and write a clip bay project (multi-track timeline). Use it to build a project from material you generated: ' +
    'mode "create" makes one in this workspace, mode "add_material" moves a generated file into the project, registers it ' +
    'and places a clip on a track (creating the track if it does not exist). mode "read" returns the whole arrangement so ' +
    'you can see what is where before changing it; mode "update" edits tracks and clips by their stable ids; mode "render" ' +
    'mixes the project down to a WAV, MP3 or MP4. ' +
    `Every write is validated against the hard limits (${LIMITS.tracks} tracks, ${LIMITS.durationSec / 60} minutes) and appends a history entry ` +
    'so the person can see what changed. When the person asks you to redo a range, change only the clips inside that range and ' +
    'leave the other tracks untouched.',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: MODES, description: 'What to do: create, add_material, read, update or render.' },
      projectId: { type: 'string', description: 'The project id. Required for every mode except create, and optional for read (omit to list projects).' },
      name: { type: 'string', description: 'create: the project name.' },
      sampleRate: { type: 'number', description: 'create: internal sample rate, default 48000.' },
      note: { type: 'string', description: 'A short human sentence recorded in the project history.' },
      sourcePath: { type: 'string', description: 'add_material: the file to move into the project, relative to the workspace or absolute.' },
      kind: {
        type: 'string',
        enum: MATERIAL_KINDS,
        description: 'add_material: what this material is. Use "music-stem" for an individual instrument stem of a piece.',
      },
      trackName: { type: 'string', description: 'add_material: the track to place this clip on; created when it does not exist. Omit to only register the material.' },
      category: { type: 'string', enum: TRACK_CATEGORIES, description: 'add_material: the track category when the track is created.' },
      startSec: { type: 'number', description: 'add_material: where the clip starts on the timeline, default 0.' },
      inSec: { type: 'number', description: 'add_material: the in point within the material, default 0.' },
      outSec: { type: 'number', description: 'add_material: the out point within the material, default the whole material.' },
      gainDb: { type: 'number', description: 'add_material: clip gain in dB.' },
      pan: { type: 'number', description: 'add_material: clip pan, -1 left to +1 right.' },
      fadeInSec: { type: 'number', description: 'add_material: fade-in length in seconds.' },
      fadeOutSec: { type: 'number', description: 'add_material: fade-out length in seconds.' },
      label: { type: 'string', description: 'add_material: the clip label shown on the timeline.' },
      changes: {
        type: 'array',
        description: 'update: the edits to apply, each addressing the project, a track or a clip by id.',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: ['project', 'track', 'clip', 'material'], description: 'project: name, masterFaderDb or masterFx (no trackId needed). track: name, muted, solo, or "delete" to remove the whole track — a track is a grouping and has no volume, pan or effects of its own; set those on its clips. clip: startSec, inSec, outSec, gainDb, pan, fadeInSec, fadeOutSec, muted, label, fx, or "delete" to remove that one clip. material: "delete" to remove a material file — refused while any clip still uses it.' },
            trackId: { type: 'string', description: 'Required for target:"track". For target:"clip" it may be left out: the clip id is unique across the project, so the host works out which track owns it.' },
            clipId: { type: 'string', description: 'Required for target:"clip".' },
            materialId: { type: 'string', description: 'Required for target:"material". mode:"read" lists every material id with its measured level and how many clips use it.' },
            field: { type: 'string' },
            value: {},
          },
          required: ['target', 'field'],
        },
      },
      format: { type: 'string', enum: ['wav', 'mp3', 'mp4'], description: 'render: the output format, default wav.' },
      output: { type: 'string', description: 'render: the output path; relative paths resolve against the workspace.' },
    },
    required: ['mode'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        mode: { type: 'string' },
        projectId: { type: 'string' },
        name: { type: 'string' },
        durationSec: { type: 'number' },
        folder: { type: 'string' },
        file: { type: 'string' },
        relative: { type: 'string' },
        format: { type: 'string' },
        peakDb: { type: 'number' },
        rmsDb: { type: 'number' },
        tracks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        materials: { type: 'array', items: { type: 'object', additionalProperties: true } },
        projects: { type: 'array', items: { type: 'object', additionalProperties: true } },
        applied: { type: 'array', items: { type: 'string' } },
        // `null` is a real answer here, not a missing field: importing a picture
        // that carries no audio stream legitimately produces no material and no
        // clip. Declaring only `object` made the host reject the whole call with
        // "returned invalid output: value.clip must be an object" — on exactly the
        // path I-05 sends people down to get a finished MP4. The host's schema
        // subset does not accept type arrays, so the nullable form is oneOf.
        clip: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        material: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
      },
    },
    render: textRenderer((_args, value) => {
      if (value.mode === 'render') {
        return [
          `Rendered ${Number(value.durationSec).toFixed(2)}s of ${value.trackCount} tracks (${value.clipCount} clips) → ${value.relative || value.file}`,
          `peak ${Number(value.peakDb).toFixed(1)} dBFS, RMS ${Number(value.rmsDb).toFixed(1)} dBFS`,
          'The clip bay shows this project as it is on disk, so no further step is needed.',
        ].join('\n')
      }
      if (value.mode === 'create') {
        return [
          `Created project "${value.name}" (${value.projectId}) in ${value.folder}`,
          'Add material with mode "add_material", or let anyaudio_music / anyaudio_tts / anyaudio_sfx place what they generate on their own tracks.',
          // "give each generated file its own track" used to sit here, and it is
          // what split eleven narration lines across eleven tracks in the session
          // that prompted this: the first thing an agent reads after creating a
          // project told it to do exactly that. Tracks follow what the person will
          // want to move — one per stem, one per voice, one per ambience/foley
          // family — not one per file.
          'Put each instrument stem on its own track, keep every line of one voice on a single narration track (a second voice gets a second track), and keep ambience apart from foley. Do not open a track per sentence.',
          // The pointer has to arrive here, not only in the system prompt. The
          // session this came from never loaded the skill at all: `skill` was
          // called zero times, so every rule that lived only in
          // `anyaudio-clipbay.md` — frozen snapshots, "only the range that was
          // asked about", no hand-rolled ffmpeg — was invisible to it. A file
          // listed in the catalog does not tell an agent when to open it; a line
          // in the reply it is reading right now does.
          'Before laying out tracks or editing this project, load the "anyaudio-clipbay" skill — it carries the placement rules, how to change one range without touching the rest, and how a finished file is meant to be produced.',
          // The one sentence that has to arrive with the project itself: a
          // material is measured when it lands, and rebalancing is a clip field,
          // not a second render (improvement plan 03, I-42).
          'Every material is measured as it enters the project (peakDb / rmsDb in the material index, shown by mode:"read"). To change the balance, set the clip gain (target:"clip", field:"gainDb") — changing a clip never re-renders the material, so do not re-generate what is already here.',
          // The configured narration engine is invisible to the Agent until it
          // runs a TTS call, and by then it has already chosen one. Naming it
          // here is the difference between "leave it out" and "guess the engine
          // and override the person's setting" (improvement plan 04).
          value.narration
            ? `Narration default right now: ${value.narration.label} (${value.narration.provider}) with voice ${value.narration.voice} [${value.narration.voiceId}]. Leave provider and voice out unless the person asked for a particular engine or voice — passing them overrides this setting.`
            : null,
        ].filter(Boolean).join('\n')
      }
      if (value.mode === 'add_material') {
        const summary = `Project now has ${value.tracks.length} tracks, ${Number(value.durationSec).toFixed(2)}s long.`
        // With a picture in the project, render can produce the finished file.
        // Saying it here matters: without this sentence the way to a finished
        // MP4 looked like a separate ffmpeg run, so an agent took that route and
        // left the project describing an arrangement nobody could watch (I-05).
        const pictureNote = value.video?.path
          ? `The project now has a picture (${value.tracks.length} tracks, ${Number(value.durationSec).toFixed(2)}s). anyaudio_project mode:"render" format:"mp4" produces the finished file with this picture and the mixed audio.`
          : null
        if (value.silent) {
          return [
            'The picture was imported as a reference picture, but it has no audio stream, so there is no soundtrack material to place.',
            ...(pictureNote ? [pictureNote] : []),
            summary,
          ].join('\n')
        }
        const lines = [
          `Added ${value.material.kind} material ${value.material.id} (${Number(value.material.durationSec).toFixed(2)}s)`,
        ]
        if (value.clip) lines.push(`Placed it on "${value.clip.trackName}" at ${Number(value.clip.startSec).toFixed(2)}s`)
        else lines.push('It is registered but not placed on a track.')
        lines.push(pictureNote ?? summary)
        return lines.join('\n')
      }
      if (value.mode === 'update') {
        return [`Applied ${value.applied.length} change(s):`, ...value.applied.map((note) => `- ${note}`)].join('\n')
      }
      if (Array.isArray(value.projects)) {
        if (value.projects.length === 0) return 'This workspace has no clip bay projects yet.'
        return ['Projects:', ...value.projects.map((row) => `- ${row.name} (${row.id}), ${row.trackCount} tracks`)].join('\n')
      }
      const lines = [
        `Project "${value.name}" (${value.projectId}), ${Number(value.durationSec).toFixed(2)}s`,
        `Tracks (${value.tracks.length} of ${LIMITS.tracks}):`,
      ]
      if (value.draft) {
        lines.push('Note: the clip bay has unsaved changes (project.draft.json); the arrangement below is the last saved one. Ask before assuming the person wants those changes kept.')
      }
      for (const track of value.tracks) {
        const clips = track.clips ?? []
        // The id comes first because it is the only handle a caller has: without
        // it the reply names a track the Agent cannot address, so renaming,
        // muting or deleting one was impossible even though `update` supports all
        // three (measured on a real session: the Agent read the project, saw
        // "旁白 · 晓晓 · 晓晓", wrote "read 返回轨道名但无 id", and gave up).
        lines.push(`- ${track.id} "${track.name}" [${track.category}]${track.muted ? ' (muted)' : ''}${track.solo ? ' (solo)' : ''} ${clips.length ? `(${clips.length} clips)` : '(empty)'}`)
        for (const item of clips) {
          const end = Number(item.startSec) + (Number(item.outSec) - Number(item.inSec))
          // The gain is reported for the same reason: a change is absolute, not
          // relative, so an Agent that cannot see the current value has to
          // overwrite it — and would silently undo a level the person set in the
          // clip bay by hand.
          const gain = Number(item.gainDb) || 0
          lines.push(`    ${item.id} "${item.label}" ${Number(item.startSec).toFixed(2)}–${end.toFixed(2)}s, gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB, material ${item.material}`)
        }
      }
      if (value.video) lines.push(`Video: ${value.video.path} (${Number(value.video.durationSec).toFixed(2)}s)`)
      const materials = value.materials ?? []
      if (materials.length > 0) {
        // The material list is the ledger the mix reads (I-37) and the place an
        // orphan finally becomes visible (I-40): before this, 34 of one
        // project's 46 materials were 398 MB nobody could see or remove.
        const orphans = materials.filter((material) => !material.referencedBy)
        const level = (material) => (material.rmsDb === null || material.rmsDb === undefined
          ? 'level unknown'
          : `${Number(material.rmsDb).toFixed(1)} dBFS RMS`)
        lines.push(`Materials (${materials.length}, ${orphans.length} unused):`)
        for (const material of materials) {
          const used = material.referencedBy ? `${material.referencedBy} clip${material.referencedBy === 1 ? '' : 's'}` : 'unused'
          lines.push(`- ${material.id} [${material.kind}] ${Number(material.durationSec).toFixed(2)}s, ${level(material)}, ${used}${material.source ? `, ${material.source}` : ''}`)
        }
        if (orphans.length > 0) {
          lines.push(`Remove unused material with mode:"update", target:"material", field:"delete", materialId:"..." — ${orphans.map((material) => material.id).join(', ')}`)
        }
      }
      return lines.join('\n')
    }),
  },
  execute: async (args, exec) => {
    const mode = args?.mode
    if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}"; use one of ${MODES.join(', ')}`)
    const workspaceRoot = await requireWorkspace(exec)
    switch (mode) {
      case 'create': return runCreate(workspaceRoot, args)
      case 'add_material': return runAddMaterial(workspaceRoot, args, exec)
      case 'read': return runRead(workspaceRoot, args)
      case 'update': return runUpdate(workspaceRoot, args)
      case 'render': return runRender(workspaceRoot, args, exec)
      default: throw new Error(`unknown mode "${mode}"`)
    }
  },
})

export function registerProjectTool(ctx) {
  ctx.tools.register(projectToolDefinition)
}
