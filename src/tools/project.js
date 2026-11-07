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
import { contentEndSec, LIMITS, TRACK_CATEGORIES, MATERIAL_KINDS } from '../project/schema.js'
import { createProject, listProjects, readMaterialIndex, readProject, saveProject, writeMaterialIndex } from '../project/store.js'
import { findMaterial, registerMaterial, deleteMaterial } from '../project/materials.js'
import { importFile, importGeneratedMaterial } from '../project/import.js'
import { exportProject, renderProject } from '../project/render.js'
import { ensureTrack, placeClip } from '../project/attach.js'
import { projectDir, resolveInside } from '../project/paths.js'
import { findFfmpeg, finalizeTool, nowStamp, outputDir, relativeToWorkspace, resolveOutputPath, textBlocks, textRenderer, workspaceRootOf } from './shared.js'
import { readConfig } from '../config.js'

const MODES = ['create', 'add_material', 'read', 'update', 'render']

function requireWorkspace(exec) {
  return workspaceRootOf(exec).then((root) => {
    if (!root) throw new Error('no workspace folder is open; open one before using the clip bay')
    return root
  })
}


async function projectSummary(workspaceRoot, project) {
  const index = await readMaterialIndex(workspaceRoot, project.id)
  return {
    projectId: project.id,
    name: project.name,
    durationSec: contentEndSec(project),
    folder: relativeToWorkspace(workspaceRoot, projectDir(workspaceRoot, project.id)),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      category: track.category,
      volumeDb: track.volumeDb,
      pan: track.pan,
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
      })),
    })),
    materials: index.materials.map((material) => ({
      id: material.id,
      kind: material.kind,
      file: material.file,
      durationSec: material.durationSec,
      source: material.source?.tool ?? material.source?.kind ?? 'unknown',
    })),
    video: project.video ?? null,
  }
}

/**
 * Apply one field change to a track or a clip, addressed by id. Kept deliberately
 * narrow: the Agent names a field and a value, and this refuses what the schema
 * would reject rather than writing a project the clip bay cannot open.
 */
function applyUpdate(project, { target, trackId, clipId, field, value }) {
  const track = project.tracks.find((entry) => entry.id === trackId)
  if (!track) throw new Error(`no such track: ${trackId}`)

  if (target === 'track') {
    switch (field) {
      case 'name': track.name = String(value).slice(0, 80); return `重命名轨道「${track.name}」`
      case 'volumeDb': track.volumeDb = Number(value); return `调整轨道「${track.name}」音量 ${track.volumeDb} dB`
      case 'pan': track.pan = Number(value); return `调整轨道「${track.name}」声像 ${track.pan}`
      case 'muted': track.muted = Boolean(value); return `${track.muted ? '静音' : '取消静音'}轨道「${track.name}」`
      case 'solo': track.solo = Boolean(value); return `${track.solo ? '独奏' : '取消独奏'}轨道「${track.name}」`
      default: throw new Error(`unknown track field "${field}"; use name, volumeDb, pan, muted or solo`)
    }
  }

  const clip = track.items.find((entry) => entry.id === clipId)
  if (!clip) throw new Error(`no such clip: ${clipId}`)
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
    default: throw new Error(`unknown clip field "${field}"; use startSec, inSec, outSec, gainDb, pan, fadeInSec, fadeOutSec, muted or label`)
  }
  return `调整片段「${clip.label || clip.id}」的 ${field}`
}

async function runCreate(workspaceRoot, args) {
  const project = await createProject(workspaceRoot, {
    name: args.name,
    sampleRate: Number(args.sampleRate) || 48000,
    by: 'agent',
    note: args.note || '创建工程',
  })
  return { ok: true, mode: 'create', ...(await projectSummary(workspaceRoot, project)) }
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

async function runUpdate(workspaceRoot, args) {
  const project = await readProject(workspaceRoot, args.projectId)
  const notes = []
  for (const change of args.changes ?? []) {
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
        description: 'update: the edits to apply, each addressing a track or clip by id.',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: ['track', 'clip'] },
            trackId: { type: 'string' },
            clipId: { type: 'string' },
            field: { type: 'string' },
            value: {},
          },
          required: ['target', 'trackId', 'field'],
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
        clip: { type: 'object', additionalProperties: true },
        material: { type: 'object', additionalProperties: true },
      },
    },
    render: textRenderer((_args, value) => {
      if (value.mode === 'render') {
        return [
          `Rendered ${Number(value.durationSec).toFixed(2)}s of ${value.tracks} tracks (${value.clips} clips) → ${value.relative || value.file}`,
          `peak ${Number(value.peakDb).toFixed(1)} dBFS, RMS ${Number(value.rmsDb).toFixed(1)} dBFS`,
          'The clip bay shows this project as it is on disk, so no further step is needed.',
        ].join('\n')
      }
      if (value.mode === 'create') {
        return [
          `Created project "${value.name}" (${value.projectId}) in ${value.folder}`,
          'Add material with mode "add_material": give each generated file its own track so the person can mix them apart.',
        ].join('\n')
      }
      if (value.mode === 'add_material') {
        if (value.silent) {
          return [
            'The picture was imported as a reference picture, but it has no audio stream, so there is no soundtrack material to place.',
            `Project now has ${value.tracks.length} tracks, ${Number(value.durationSec).toFixed(2)}s long.`,
          ].join('\n')
        }
        const lines = [
          `Added ${value.material.kind} material ${value.material.id} (${Number(value.material.durationSec).toFixed(2)}s)`,
        ]
        if (value.clip) lines.push(`Placed it on "${value.clip.trackName}" at ${Number(value.clip.startSec).toFixed(2)}s`)
        else lines.push('It is registered but not placed on a track.')
        lines.push(`Project now has ${value.tracks.length} tracks, ${Number(value.durationSec).toFixed(2)}s long.`)
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
      for (const track of value.tracks) {
        lines.push(`- ${track.name} [${track.category}] ${track.volumeDb}dB ${track.items.length ? `(${track.items.length} clips)` : '(empty)'}`)
        for (const item of track.items) {
          const end = Number(item.startSec) + (Number(item.outSec) - Number(item.inSec))
          lines.push(`    ${item.id} "${item.label}" ${Number(item.startSec).toFixed(2)}–${end.toFixed(2)}s, material ${item.material}`)
        }
      }
      if (value.video) lines.push(`Video: ${value.video.path} (${Number(value.video.durationSec).toFixed(2)}s)`)
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
