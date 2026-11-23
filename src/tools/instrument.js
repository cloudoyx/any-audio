// anyaudio_instrument — VST3 instrument rendering tool.
//
// The Agent names a catalog instrument (or a VST3 path) and notes in the
// independent { pitch, start, dur, vel } format; the sidecar
// (engine/vst3_worker.py, driven by src/audio/vst3-process.js) renders them on
// the local machine. The result lands on its own track in the clip bay as a
// single WAV, so it can be played, gain-adjusted and regenerated.
//
// Action "list" needs no project: it is how the Agent discovers the instrument
// ids, their measured playable range and their articulation keyswitches.
// Action "render" requires a projectId and attaches the WAV as material, the
// same way anyaudio_tts and anyaudio_sing do.

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { toDb } from '../audio/wav.js'
import { builtInCatalog } from '../audio/vst3-catalog.js'
import { createVst3Process } from '../audio/vst3-process.js'
import { attachMaterialFile } from '../project/attach.js'
import { projectDir } from '../project/paths.js'
import {
  finalizeTool, nowStamp, relativeToWorkspace, requireProjectId, scratchPath,
  textRenderer, workspaceRootOf,
} from './shared.js'

// Injection point: tests install a fake process factory so no real plugin or
// python runtime is needed. Same shape as the singing tool's factory.
let processFactory = (options) => createVst3Process(options)
export function setVst3ProcessFactory(factory) {
  processFactory = factory ?? ((options) => createVst3Process(options))
}

/** Find a catalog entry by id, display name or plugin file name. */
function findCatalogEntry(catalog, wanted) {
  const value = String(wanted ?? '').trim()
  if (!value) return null
  return catalog.plugins.find((entry) => entry.id === value)
    ?? catalog.plugins.find((entry) => entry.name === value)
    ?? catalog.plugins.find((entry) => basename(entry.plugin).toLowerCase() === value.toLowerCase())
    ?? null
}

function resolvePlugin(raw) {
  const catalog = builtInCatalog()
  const wanted = typeof raw === 'string' ? raw.trim() : ''
  if (!wanted) {
    throw new Error('anyaudio_instrument needs "plugin": a catalog id (see action "list") or a VST3 path')
  }
  const entry = findCatalogEntry(catalog, wanted)
  if (entry) return { entry, path: entry.plugin, label: entry.name }
  return { entry: null, path: wanted, label: basename(wanted) || wanted }
}

/** Validate + normalise notes into the sidecar's { pitch, start, dur, vel } shape. */
function parseNotes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('anyaudio_instrument needs a non-empty "notes" array of { pitch, start, dur, vel }')
  }
  return raw.map((note, index) => {
    const label = `notes[${index}]`
    if (!note || typeof note !== 'object') {
      throw new Error(`${label} 必须是 { pitch, start, dur, vel } 对象`)
    }
    const pitch = Number(note.pitch)
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
      throw new Error(`${label}.pitch 必须是 0-127 的整数（MIDI 编号），现在是 ${JSON.stringify(note.pitch)}`)
    }
    const start = Number(note.start ?? 0)
    if (!Number.isFinite(start) || start < 0) {
      throw new Error(`${label}.start 必须是不小于 0 的秒数`)
    }
    const dur = Number(note.dur)
    if (!Number.isFinite(dur) || dur <= 0) {
      throw new Error(`${label}.dur 必须是大于 0 的秒数`)
    }
    const vel = note.vel === undefined || note.vel === null ? 100 : Number(note.vel)
    if (!Number.isInteger(vel) || vel < 0 || vel > 127) {
      throw new Error(`${label}.vel 必须是 0-127 的整数`)
    }
    return { pitch, start, dur, vel }
  })
}

/** Reject notes the instrument cannot sound instead of writing a silent WAV. */
function checkRange(entry, notes) {
  if (!entry?.range) return
  const { low, high } = entry.range
  const bad = [...new Set(notes.filter((note) => note.pitch < low || note.pitch > high).map((note) => note.pitch))]
    .sort((a, b) => a - b)
  if (bad.length > 0) {
    throw new Error(
      `${entry.name} 的实测音域是 MIDI ${low}-${high}，这些音高超出会静音：${bad.join(', ')}。`
      + '请把音高移进音域，或换一个音源（action "list" 可看全部音源）。',
    )
  }
}

/** Turn a process-manager error into a clear Chinese tool error. */
function describeRenderError(error, label) {
  const message = error instanceof Error ? error.message : String(error)
  switch (error?.code) {
    case 'LOAD_FAILED':
      return `加载音源「${label}」失败：${message}`
    case 'RENDER_FAILED':
      return `渲染「${label}」失败：${message}`
    case 'RENDER_TIMEOUT':
      return `渲染「${label}」超时：${message}`
    case 'ENV_MISSING':
    case 'WORKER_MISSING':
      return `VST3 渲染环境不可用：${message}`
    case 'SPAWN_FAILED':
    case 'WORKER_EXITED':
      return `VST3 渲染进程异常退出：${message}`
    default:
      return `渲染「${label}」失败：${message}`
  }
}

export const instrumentToolDefinition = finalizeTool({
  name: 'anyaudio_instrument',
  description:
    'Render a VST3 instrument into a clip bay project as an adjustable material. ' +
    'Action "list" returns the built-in instrument catalog (id, name, vendor, measured playable MIDI range, articulation keyswitches, effect sounds) and needs no projectId. ' +
    'Action "render" takes projectId, plugin (a catalog id or a VST3 path), notes [{pitch, start, dur, vel}] and duration (seconds), renders them with the local VST3 sidecar, and attaches the WAV to a track so the person can open, hear and adjust it. ' +
    'Notes are { pitch: MIDI 0-127, start: seconds, dur: seconds, vel: 0-127 }. ' +
    'Each instrument has a measured playable range (Ample Bass 40-72, Ample Guitar 42-84); notes outside it are silent, so the tool rejects them instead of writing an empty WAV. ' +
    'The first render of a plugin takes a few seconds while the sampler warms up. ' +
    'Failures (bad plugin path, out-of-range notes, silent render) are explicit errors, never a silent empty file.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'render'], description: 'What to do; defaults to "list".' },
      projectId: { type: 'string', description: 'The clip bay project this instrument belongs to. Required for action "render": run anyaudio_project mode:"create" first when the task has no project yet.' },
      plugin: { type: 'string', description: 'Catalog id (e.g. "ample-bass-p-lite") or a VST3 path. Required for action "render"; action "list" shows the ids.' },
      notes: {
        type: 'array',
        description: 'Notes to render: [{ pitch, start, dur, vel }]. pitch is MIDI 0-127, start/dur are seconds, vel is 0-127 (default 100).',
        items: { type: 'object', additionalProperties: true },
      },
      duration: { type: 'number', description: 'Render length in seconds (must be greater than 0). Include the release tail: a 0.5s note usually wants 1.0-1.5s.' },
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        version: { type: 'number' },
        plugins: { type: 'array', items: { type: 'object', additionalProperties: true } },
        projectId: { type: 'string' },
        plugin: { type: 'object', additionalProperties: true },
        file: { type: 'string' },
        absolutePath: { type: 'string' },
        attached: { type: 'object', additionalProperties: true },
        peak: { type: 'number' },
        peakDb: { type: 'number' },
        seconds: { type: 'number' },
        durationSec: { type: 'number' },
        sampleRate: { type: 'number' },
        notes: { type: 'number' },
      },
    },
    render: textRenderer((_args, value) => {
      if (value.action === 'list') {
        return [
          'VST3 音源档案：',
          ...value.plugins.map((entry) => {
            const fx = entry.fxSounds?.length ? `，效果音 ${entry.fxSounds.length} 个` : ''
            return `- ${entry.id} — ${entry.name}（${entry.vendor}），音域 MIDI ${entry.range.low}-${entry.range.high}，演奏法 ${entry.articulations.map((item) => item.name).join('、')}${fx}`
          }),
          '用 action:"render" + plugin（id 或路径）+ notes + duration 渲染，结果会挂进工程成为可调素材。',
        ].join('\n')
      }
      return [
        `渲染完成：${value.plugin.name}，${value.notes} 个音，${Number(value.seconds).toFixed(2)}s @ ${value.sampleRate} Hz`,
        `峰值 ${Number(value.peakDb).toFixed(1)} dBFS → ${value.file}`,
        `已挂到工程 ${value.projectId} 的轨道「${value.attached?.trackName}」@ ${Number(value.attached?.startSec ?? 0).toFixed(2)}s（clip ${value.attached?.clipId}）`,
      ].join('\n')
    }),
  },
  async execute(args, exec) {
    const action = args.action ?? 'list'
    if (action === 'list') {
      const catalog = builtInCatalog()
      return {
        ok: true,
        action: 'list',
        version: catalog.version,
        plugins: catalog.plugins.map((entry) => ({
          id: entry.id,
          name: entry.name,
          vendor: entry.vendor,
          plugin: entry.plugin,
          range: entry.range,
          articulations: entry.articulations,
          fxSounds: entry.fxSounds,
          notes: entry.notes,
        })),
      }
    }
    if (action !== 'render') {
      throw new Error(`unknown action "${action}"; use "list" or "render"`)
    }

    const workspaceRoot = await workspaceRootOf(exec)
    const projectId = requireProjectId(args, 'anyaudio_instrument')
    const { entry, path: pluginPath, label } = resolvePlugin(args.plugin)
    if (!existsSync(pluginPath)) {
      throw new Error(
        `音源插件不存在：${pluginPath}。先用 anyaudio_instrument action:"list" 查看可用音源，或确认 VST3 已安装。`,
      )
    }
    const notes = parseNotes(args.notes)
    checkRange(entry, notes)
    const duration = Number(args.duration)
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('anyaudio_instrument needs "duration": the render length in seconds (must be greater than 0)')
    }

    const stamp = nowStamp()
    const target = scratchPath(workspaceRoot, `vst3-${stamp}.wav`)
    await mkdir(dirname(target), { recursive: true })

    const manager = processFactory()
    let result
    try {
      result = await manager.render({ plugin: pluginPath, notes, duration, out: target })
    } catch (error) {
      throw new Error(describeRenderError(error, label))
    } finally {
      await manager.shutdown().catch(() => {})
    }

    const peakDb = Number(toDb(result.peak).toFixed(1))
    const trackName = `音源 · ${entry?.name ?? label}`
    let attached
    try {
      attached = await attachMaterialFile(workspaceRoot, projectId, target, {
        kind: 'music',
        trackName,
        category: 'music',
        snapshot: { plugin: pluginPath, notes, duration },
        snapshotKind: 'vst3',
        tool: 'anyaudio_instrument',
        label: `${entry?.name ?? label} · ${notes.length} 音`,
        autoStart: true,
        peakDb,
        signal: exec?.signal,
      })
    } finally {
      await rm(target, { force: true })
    }
    const projectCopy = join(projectDir(workspaceRoot, projectId), attached.file)

    return {
      ok: true,
      action: 'render',
      projectId,
      plugin: { id: entry?.id ?? null, name: entry?.name ?? label, path: pluginPath },
      file: relativeToWorkspace(workspaceRoot, projectCopy),
      absolutePath: projectCopy,
      attached,
      peak: result.peak,
      peakDb,
      seconds: result.seconds,
      durationSec: result.seconds,
      sampleRate: 48000,
      notes: notes.length,
    }
  },
})

export function registerInstrumentTool(ctx) {
  ctx.tools.register(instrumentToolDefinition)
}
