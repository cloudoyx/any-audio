/**
 * `anyaudio://` timeline references (spec §9.3, path B).
 *
 * The clip bay's 添加到对话 button writes plain Markdown into the chat draft:
 *
 *   @[鼓组 00:01:12–00:01:26](anyaudio://timeline/prj_ab12cd34/trk_01@72.0-86.0)
 *
 * The user can edit or delete it like any other text. When the message is sent,
 * this hook replaces the mention with `@鼓组` and appends one structured block
 * describing the target, so the Agent knows exactly which project, track or clip
 * and which range to change — and, just as important, which ones not to touch.
 *
 * The project id is part of the URI because a workspace holds many projects and a
 * track id is only unique inside one. Spec §9.3 shows the shorter
 * `anyaudio://timeline/trk_01@72.0-86.0` form, which cannot name a target on its
 * own; this is the corrected shape.
 */
import { readMaterialIndex, readProject } from '../project/store.js'

const MENTION = /@\[([^\]\n]*)\]\(anyaudio:\/\/timeline\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:@(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?))?\)/gu

/** `72.5` → `00:01:12.500`. */
export function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const whole = Math.floor(value)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const millis = Math.round((value - whole) * 1000)
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`
}

/**
 * Split one text value into readable text and the timeline references it cites.
 * A mention keeps its label in the text so the sentence still reads naturally.
 */
export function parseTimelineMentions(text) {
  const references = []
  const cleaned = String(text ?? '').replace(MENTION, (match, label, projectId, target, from, to) => {
    references.push({
      label: label || target,
      projectId,
      target,
      fromSec: from === undefined ? null : Number(from),
      toSec: to === undefined ? null : Number(to),
    })
    return `@${label || target}`
  })
  return { text: cleaned, references }
}

function findTarget(project, target) {
  const track = project.tracks.find((entry) => entry.id === target)
  if (track) return { kind: 'track', track }
  for (const candidate of project.tracks) {
    const item = candidate.items.find((entry) => entry.id === target)
    if (item) return { kind: 'clip', track: candidate, item }
  }
  return null
}

/**
 * Describe one reference in the terms the Agent needs: which project, which
 * track or clip, what range, and what else is already sitting there.
 */
export function describeReference(project, materials, reference) {
  const lines = [`工程：${project.name}（${project.id}）`]
  const found = findTarget(project, reference.target)

  if (!found) {
    lines.push(`目标：${reference.target}（这个工程里已经没有这个轨道或片段了，工程可能被改过）`)
    return lines.join('\n')
  }

  const materialName = (id) => {
    const material = materials.find((entry) => entry.id === id)
    return material ? material.file.split('/').pop() : id
  }

  if (found.kind === 'track') {
    const { track } = found
    lines.push(`轨道：${track.name}（${track.id}，${track.category}，${track.volumeDb} dB）`)
    const from = reference.fromSec
    const to = reference.toSec
    if (from !== null && to !== null) {
      lines.push(`时间范围：${formatTime(from)} — ${formatTime(to)}`)
      const inside = track.items.filter((item) => {
        const end = item.startSec + (item.outSec - item.inSec)
        return end > from && item.startSec < to
      })
      if (inside.length === 0) {
        lines.push('这个范围在轨道上是空的。')
      } else {
        lines.push('落在范围内的片段：')
        for (const item of inside) {
          const end = item.startSec + (item.outSec - item.inSec)
          lines.push(
            `  - ${item.label || item.id}（${item.id}）${formatTime(item.startSec)} — ${formatTime(end)}` +
              `，素材 ${materialName(item.material)}，源区间 ${item.inSec.toFixed(3)}–${item.outSec.toFixed(3)}s` +
              `，增益 ${item.gainDb} dB，声像 ${item.pan}`,
          )
        }
      }
    } else {
      lines.push(`片段数：${track.items.length}`)
      for (const item of track.items) {
        const end = item.startSec + (item.outSec - item.inSec)
        lines.push(`  - ${item.label || item.id}（${item.id}）${formatTime(item.startSec)} — ${formatTime(end)}，素材 ${materialName(item.material)}`)
      }
    }
    return lines.join('\n')
  }

  const { track, item } = found
  const end = item.startSec + (item.outSec - item.inSec)
  lines.push(`轨道：${track.name}（${track.id}，${track.volumeDb} dB）`)
  lines.push(`片段：${item.label || item.id}（${item.id}）`)
  lines.push(`位置：${formatTime(item.startSec)} — ${formatTime(end)}`)
  lines.push(`素材：${materialName(item.material)}，源区间 ${item.inSec.toFixed(3)}–${item.outSec.toFixed(3)}s`)
  lines.push(`参数：增益 ${item.gainDb} dB，声像 ${item.pan}，淡入 ${item.fadeInSec}s，淡出 ${item.fadeOutSec}s`)
  if (reference.fromSec !== null && reference.toSec !== null) {
    lines.push(`提到的范围：${formatTime(reference.fromSec)} — ${formatTime(reference.toSec)}`)
  }
  return lines.join('\n')
}

const HOOK_OPEN = '<anyaudio-timeline>'
const HOOK_CLOSE = '</anyaudio-timeline>'

/**
 * Expand every timeline mention in one batch of messages: the user's text keeps a
 * readable `@label`, and one extra message carries the structured description.
 *
 * A reference whose project is gone is reported rather than thrown away, because
 * silently dropping it would leave the Agent guessing at an instruction like
 * "make this part louder".
 */
export async function expandTimelineReferences(workspaceRoot, messages) {
  if (!workspaceRoot || !Array.isArray(messages) || messages.length === 0) return messages
  const out = []
  for (const message of messages) {
    if (message?.source?.kind !== 'user' || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const blocks = []
    const collected = []
    for (const block of message.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') {
        blocks.push(block)
        continue
      }
      const parsed = parseTimelineMentions(block.text)
      collected.push(...parsed.references)
      blocks.push({ ...block, text: parsed.text })
    }
    if (collected.length === 0) {
      out.push(message)
      continue
    }

    const cache = new Map()
    const sections = []
    for (const reference of collected) {
      let entry = cache.get(reference.projectId)
      if (!entry) {
        try {
          const project = await readProject(workspaceRoot, reference.projectId)
          const index = await readMaterialIndex(workspaceRoot, reference.projectId)
          entry = { project, materials: index.materials }
        } catch (error) {
          entry = { error: error instanceof Error ? error.message : String(error) }
        }
        cache.set(reference.projectId, entry)
      }
      if (entry.error) {
        sections.push(`工程：${reference.projectId}（读不出来：${entry.error}）`)
      } else {
        sections.push(describeReference(entry.project, entry.materials, reference))
      }
    }

    out.push({ ...message, content: blocks })
    out.push({
      id: `anyaudio-timeline-${message.id ?? collected.length}`,
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `${HOOK_OPEN}\n他刚才的这句话引用了下面这段剪辑台工程。改之前先确认工程当前状态，` +
            `只动他指到的范围，其他轨道和片段保持原样。\n\n${sections.join('\n\n')}\n${HOOK_CLOSE}`,
        },
      ],
      source: { kind: 'any-audio', form: 'timeline-reference' },
    })
  }
  return out
}

/**
 * Register the pre-step expansion. Runs last (`prepend: false` is the default
 * ordering direction here) so it sees the messages other hooks already accepted.
 */
export function registerTimelineExpansion(ctx, log = () => {}) {
  if (typeof ctx?.on !== 'function') return null
  return ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      if (decision?.kind !== 'enter') return decision
      const workspaceRoot = payload?.agent?.session?.header?.cwd
      if (!workspaceRoot) return decision
      try {
        const messages = await expandTimelineReferences(workspaceRoot, decision.messages)
        return { ...decision, messages }
      } catch (error) {
        log(`timeline reference expansion failed: ${error instanceof Error ? error.message : String(error)}`)
        return decision
      }
    },
    { prepend: true },
  )
}
