/**
 * Clip bay — the multichannel editing surface.
 *
 * Plan M4: the tab exists, it opens, and it lists the projects of the workspace
 * the user is currently looking at. M5 added the timeline (waveform, playback,
 * clip and track edits, undo, autosave) and M8 the picture preview and export.
 *
 * The workspace is resolved from the Session the View is mounted for: the Host
 * scopes `conversation.view` to one Session and hands `sessionId` to every
 * entry, so the owning workspace is a lookup, not a guess. A widget folder
 * belongs to its workspace, and every Session of that workspace may read and
 * edit it — the Session decides which workspace the page opens on, never which
 * data exists. The host re-checks the path against its own registry, so a
 * mismatched root fails closed (403) rather than reading someone else's folder.
 */
import { h, useState, useEffect, useCallback, S, C, Btn, Notice, Select, Slider, Switch, useSurface } from '../ui.js'
import { api, API } from '../api.js'
import { t, detectLanguage, setLanguage, languageFromLocale } from '../i18n.js'
import { useProject } from './state.js'
import { usePlayback } from './audio.js'
import { useDraftAutosave } from './saving.js'
import { useExport, availableFormats, describeJob } from './exporter.js'
import { Timeline } from './timeline.js'
import { MaterialBin } from './material-bin.js'
import { Preview } from './preview.js'
import { ClipProperties } from './properties.js'
import { FxEditor } from './fx-editor.js'
import { buildMention, appendToDraft } from './mention.js'
import {
  moveClip, trimClip, splitClip, deleteClip, duplicateClip,
  setClipGain, setClipPan, setClipFades, setClipMuted, assertWithinLimits,
  renameTrack, setTrackMuted, setTrackSolo, deleteTrack,
  setClipFx, setMasterFx, setMasterFader,
  EditError,
} from './edit.js'

export const CLIP_BAY_ID = 'clip-bay'

/**
 * The workspace that owns a Session.
 *
 * `items` is the `WorkspaceSnapshot.items` array and `sessionId` is the Session
 * this View is mounted for. There is deliberately no "first workspace" fallback:
 * the clip bay writes to disk (autosave, export), so picking a folder the user
 * is not looking at would write into someone else's project. An unmatched id
 * means the Session has no workspace yet, which the caller shows as an empty
 * state.
 */
export function workspaceForSession(items, sessionId) {
  if (!Array.isArray(items) || items.length === 0) return null
  if (typeof sessionId !== 'string' || sessionId === '') return null
  return items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId)) ?? null
}

/** mm:ss, the same shape the exporter reports. */
function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * A small circled question mark next to a button.
 *
 * It carries the same words a `title` would, but visible on hover instead of
 * after the browser's own delay — and unlike a native tooltip it survives a long
 * sentence. It is deliberately small and borderless so it reads as an aside, not
 * as a second button (2026-11-10).
 */
function HelpDot({ title, text }) {
  const [hover, setHover] = useState(false)
  const surface = useSurface()
  return h('span', {
    style: { position: 'relative', display: 'inline-flex' },
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  },
    h('span', {
      title,
      style: {
        width: 15, height: 15, borderRadius: '50%', cursor: 'help',
        border: `1px solid ${hover ? C.accent : C.border}`,
        color: hover ? C.accent : C.muted,
        fontSize: 10, lineHeight: 1, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
      },
    }, '?'),
    hover ? h('span', {
      style: {
        position: 'absolute', top: 22, right: -8, zIndex: 60, width: 260,
        padding: '8px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.55,
        border: `1px solid ${C.border}`, background: surface, color: 'inherit',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
      },
    }, text) : null,
  )
}

function ProjectList({ root, onOpen }) {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const reload = useCallback(async () => {
    try {
      const data = await api(`/clipbay/projects?root=${encodeURIComponent(root)}`)
      setProjects(data.projects || [])
      setError('')
    } catch (caught) {
      setError(caught.message)
    }
  }, [root])

  useEffect(() => { void reload() }, [reload])

  if (error) {
    return h('div', { style: S.workbench },
      h(Notice, { tone: 'error' }, error),
      h('div', null, h(Btn, { onClick: () => void reload() }, t('重试'))),
    )
  }
  if (!projects) return h('div', { style: S.workbench }, h('p', { style: S.desc }, t('正在读取工程…')))
  if (projects.length === 0) {
    // The empty state teaches the product rather than apologising for being
    // empty: what the clip bay is for is easier to show with four real requests
    // than with a sentence about projects (2026-11-10).
    const examples = [
      t('做一个 30 秒的水墨动画：石缝里的一粒种子长成树苗。配一点中国风音乐和风声，不要旁白。'),
      t('古筝主旋律，弦乐铺底，大提琴走低音；人声出现时把音乐压下去。'),
      t('帮我写一首日式 RPG 的战斗曲目，可无限循环，30 秒到 60 秒。乐器用鼓组 + 电吉他 + 弦乐。'),
      t('帮我把《三国演义》第一章做成有声小说，旁白低沉浑厚，角色音色要有所区分，配一些简单的配乐和音效即可。'),
    ]
    return h('div', { style: S.workbench },
      h('div', { style: S.header },
        h('h2', { style: S.title }, t('剪辑台')),
      ),
      h('p', { style: S.desc }, t('这个工作区还没有工程。在会话里像平时一样提需求，Agent 会自己建工程并渲染音频：')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 } },
        examples.map((line, index) => h('div', {
          key: index,
          style: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', display: 'flex', gap: 10, alignItems: 'flex-start' },
        },
          h('span', { style: { flex: 1, fontSize: 12, lineHeight: 1.6 } }, `「${line}」`),
          h(Btn, {
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(line)
                setCopied(line)
              } catch {
                setCopied('')
              }
            },
          }, copied === line ? t('已复制') : t('复制')),
        )),
      ),
      h('p', { style: { ...S.desc, marginTop: 6 } }, t('也可以直接说「新建一个剪辑台工程」，先有一个空工程再让它往里加东西。')),
    )
  }
  return h('div', { style: S.workbench },
    h('div', { style: S.header },
      h('h2', { style: S.title }, t('剪辑台')),
      h('span', { style: S.chip }, `${projects.length} ${t('个工程')}`),
      h('span', { style: { flex: 1 } }),
      h(Btn, { onClick: () => void reload() }, t('刷新')),
    ),
    // One card per project, wide enough that a picture is worth looking at.
    // The card carries what a person decides on: what it looks like, how long it
    // is, how many tracks and materials, when it last changed, and whether a
    // draft is waiting. The id is kept but pushed to the quiet corner — it is a
    // thing to copy, not a thing to read.
    h('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 },
    }, projects.map((project) => h(ProjectCard, { key: project.id, root, project, onOpen }))),
  )
}

function ProjectCard({ root, project, onOpen }) {
  const [hover, setHover] = useState(false)
  const thumbSrc = project.hasVideo
    ? `${API}/clipbay/video?root=${encodeURIComponent(root)}&project=${encodeURIComponent(project.id)}#t=0.1`
    : ''
  return h('button', {
    type: 'button',
    onClick: () => onOpen(project),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', cursor: 'pointer',
      border: `1px solid ${hover ? C.accent : C.border}`, borderRadius: 12,
      background: 'transparent', color: 'inherit', textAlign: 'left',
      transition: 'transform .15s ease, box-shadow .15s ease, border-color .15s ease',
      transform: hover ? 'translateY(-2px)' : 'none',
      boxShadow: hover ? '0 8px 22px rgba(0,0,0,0.12)' : 'none',
    },
  },
    h('div', {
      style: {
        position: 'relative', aspectRatio: '16 / 9', background: '#0b0c0e', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
    },
      // A video project shows its own first frame: the browser paints it from
      // the media route, so no thumbnail has to be generated or stored.
      thumbSrc
        ? h('video', {
          src: thumbSrc,
          muted: true,
          preload: 'metadata',
          tabIndex: -1,
          style: { position: 'absolute', inset: 0, objectFit: 'cover' },
        })
        : h('div', {
          style: {
            position: 'absolute', inset: 0,
            background: 'repeating-linear-gradient(90deg, transparent 0 3px, rgba(255,255,255,0.16) 3px 4px)',
            maskImage: 'linear-gradient(180deg, transparent, #000 35%, #000 65%, transparent)',
          },
        }),
      h('div', {
        style: {
          position: 'absolute', inset: 0,
          background: 'linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.45) 100%)',
        },
      }),
      h('span', {
        style: {
          position: 'relative', color: '#fff', fontSize: 18, fontWeight: 650, letterSpacing: 0.4,
          textShadow: '0 2px 10px rgba(0,0,0,0.55)', padding: '0 18px', textAlign: 'center',
        },
      }, project.name),
    ),
    h('div', { style: { padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 7 } },
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        project.hasVideo ? h('span', { style: S.chip }, t('含视频')) : null,
        h('span', { style: S.chip }, `${project.trackCount} ${t('轨')}`),
        project.materialCount ? h('span', { style: S.chip }, `${project.materialCount} ${t('个素材')}`) : null,
        h('span', { style: S.chip }, formatDuration(project.durationSec)),
        project.hasDraft ? h('span', { style: { ...S.chip, borderColor: C.warn, color: C.warn } }, t('未保存')) : null,
      ),
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { fontSize: 11, color: C.muted } }, relativeTime(project.mtimeMs)),
        h('span', { style: S.mono }, project.id),
      ),
    ),
  )
}

/** "3 分钟前" for a file mtime, so the card says what changed recently. */
export function relativeTime(mtimeMs) {
  if (!Number.isFinite(mtimeMs)) return ''
  const seconds = Math.max(0, (Date.now() - mtimeMs) / 1000)
  if (seconds < 90) return t('刚刚修改')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('{0} 分钟前修改', minutes)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('{0} 小时前修改', hours)
  const days = Math.round(hours / 24)
  return t('{0} 天前修改', days)
}

/**
 * The clip half of the edit dispatch. Kept separate from `applyEdit` so the track
 * operations above stay readable; both end up in the same history and the same
 * save path.
 */
function applyClipEdit(project, track, item, request, playhead, trackId, itemId) {
  switch (request.kind) {
    case 'move':
      return moveClip(project, { trackId, itemId, startSec: item.startSec + request.deltaSec })
    case 'trim':
      return trimClip(project, { trackId, itemId, edge: request.edge, deltaSec: request.deltaSec })
    case 'split':
      return splitClip(project, { trackId, itemId, atSec: playhead })
    case 'delete':
      return deleteClip(project, { trackId, itemId })
    case 'duplicate':
      return duplicateClip(project, { trackId, itemId })
    case 'gain':
      return setClipGain(project, { trackId, itemId, gainDb: request.gainDb })
    case 'pan':
      return setClipPan(project, { trackId, itemId, pan: request.pan })
    case 'fades':
      return setClipFades(project, {
        trackId, itemId,
        fadeInSec: request.fadeInSec,
        fadeOutSec: request.fadeOutSec,
      })
    case 'mute':
      return setClipMuted(project, { trackId, itemId, muted: request.muted })
    case 'fx':
      return setClipFx(project, { trackId, itemId, chain: request.chain })
    default:
      return null
  }
}

/**
 * Stand-in for the conversation's `useInput` hook when the slot does not supply
 * one. It exists so the hook can be called unconditionally at the top of
 * ProjectShell: `useInput` is a hook, and calling it from a click handler is an
 * invalid hook call (React error #321) even though it looks like a getter.
 */
function useNoInput() {
  return null
}

/**
 * Height of the message composer, which the host now draws *over* the view
 * rather than beside it. The panel has to reserve that band itself or the last
 * track ends up underneath the input.
 *
 * Measured from the DOM instead of hard-coded: the composer grows when the draft
 * wraps, and its height differs between the plain and the side-panel layouts. A
 * `ResizeObserver` catches the wrap; the fallback constant is only for the first
 * paint, before that runs.
 */
const COMPOSER_FALLBACK = 127

function useComposerInset() {
  const [inset, setInset] = useState(COMPOSER_FALLBACK)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const seat = document.querySelector('[data-composer-seat]')
    if (!seat) return undefined
    const read = () => {
      const height = Math.round(seat.getBoundingClientRect().height)
      if (height > 0) setInset(height)
    }
    read()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(read)
    observer.observe(seat)
    return () => observer.disconnect()
  }, [])
  return inset
}

function ProjectShell({ root, projectId, onBack, inputActions, useInput }) {
  const { status, error, project, materials, dirty, hasDraft, reload, update, undo, redo, save, discard, canUndo, canRedo } = useProject(root, projectId)
  const transport = usePlayback(root, projectId)
  const setTransportProject = transport.setProject
  const [selection, setSelection] = useState(null)
  const [range, setRange] = useState(null)
  const [editError, setEditError] = useState('')
  const [saveError, setSaveError] = useState('')
  // Leaving with unsaved work is the one moment the person can lose it, so the
  // back button asks instead of guessing (improvement plan 05).
  const [leavePrompt, setLeavePrompt] = useState(false)
  // The guide is a drawer inside the clip bay, not a shell panel: it explains the
  // surface the person is looking at, so leaving that surface to read it would
  // defeat the point (2026-11-10).
  const [helpOpen, setHelpOpen] = useState(false)
  const [mentionNotice, setMentionNotice] = useState('')
  // Which effect chain the right-hand column is showing, if any (I-07). Null means
  // "show the selected clip": the panel is one column, so opening a track or the
  // bus chain replaces the clip properties rather than stacking three lists in
  // 220px.
  const [fxTarget, setFxTarget] = useState(null)
  const composerInset = useComposerInset()
  // A floating surface has no shell ancestor to inherit from, so it names the
  // shell background explicitly (2026-11-10).
  const surface = useSurface()
  // Export settings live in the panel, not in project.json: they describe this
  // one export, and spec §6.8 keeps one-off UI state out of the project.
  const [exportFormat, setExportFormat] = useState('')
  const [exportNormalize, setExportNormalize] = useState(false)
  // Read the draft here, at the top level, so 添加到对话 only has to append to a
  // value it already has. Both the hook and its state are stable, so the read
  // does not make the click handler stale.
  const useInputState = typeof useInput === 'function' ? useInput : useNoInput
  const draft = useInputState((state) => state)?.draft ?? ''

  // Debounced draft write plus a flush on unmount: switching to 对话 destroys
  // this component, and the last few hundred milliseconds must still reach the
  // draft. Gated on `dirty` rather than on "a project is loaded": mounting the
  // panel must not write a draft the person has not changed.
  const { flush, cancel } = useDraftAutosave(root, project, {
    enabled: Boolean(project) && dirty,
    onError: (message) => setSaveError(message),
  })

  // Closing the window is the other way to lose unsaved work; the browser's own
  // prompt is the only one that can stop a close, so it is used here.
  useEffect(() => {
    if (!dirty) return undefined
    const onBeforeUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // An export renders from project.json on disk, so anything still inside the
  // debounce window has to be written before the job starts.
  const exporter = useExport(root, projectId, { name: project?.name, beforeStart: async () => { flush() } })

  // The transport schedules from the project it is handed, so it must see the
  // current arrangement rather than whatever was loaded when it mounted.
  useEffect(() => {
    if (project) setTransportProject(project)
  }, [project, setTransportProject])

  const selectClip = useCallback((trackId, itemId) => {
    setSelection(itemId ? { trackId, itemId } : null)
  }, [])

  /**
   * Drop both the clip selection and any dragged range.
   *
   * Escape and a click on empty track space both land here. Without it the only
   * ways out of a selection were deleting the clip or reloading the page.
   */
  const clearSelection = useCallback(() => {
    setSelection(null)
    setRange(null)
  }, [])

  /**
   * Put the current selection into the chat draft as an `anyaudio://` mention
   * (spec §9.3 path B).
   *
   * The draft is read first and the mention appended, because `setDraft` replaces
   * the whole document — writing only the mention would delete whatever the person
   * had already typed. The host expands the mention into structured context when
   * the message is sent, so nothing else has to happen here.
   */
  const addToConversation = useCallback(() => {
    // A dragged range names its own track and wins over a clip selection: it is
    // the more recent, more specific gesture, and it is the only one that carries
    // a time range.
    const target = range && range.toSec > range.fromSec
      ? { trackId: range.trackId, fromSec: range.fromSec, toSec: range.toSec }
      : selection
        ? { trackId: selection.trackId, itemId: selection.itemId }
        : null
    if (!project || !target) {
      setMentionNotice(t('选中一个片段或一条轨道，再点这里把它放进对话。'))
      return
    }
    const mention = buildMention(project, target)
    if (!mention) {
      setMentionNotice(t('选中一个片段或一条轨道，再点这里把它放进对话。'))
      return
    }
    if (!inputActions?.setDraft) {
      setMentionNotice(t('加入失败：{0}', 'this build of the chat input does not expose setDraft'))
      return
    }
    try {
      inputActions.setDraft(appendToDraft(draft, mention.text))
      inputActions.persistDraft?.()
      setMentionNotice(t('已加入对话输入框，切到「对话」继续补充要求。'))
    } catch (caught) {
      setMentionNotice(t('加入失败：{0}', caught instanceof Error ? caught.message : String(caught)))
    }
  }, [project, selection, range, inputActions, draft])

  /**
   * One entry point for every edit. The mutators are pure and return a note for
   * `history`; an empty note means "nothing changed" and is not recorded, which
   * is what keeps a drag that lands back where it started out of the log.
   */
  const applyEdit = useCallback((request) => {
    if (!project) return
    const trackId = request.trackId ?? selection?.trackId
    const itemId = request.itemId ?? selection?.itemId
    const track = project.tracks.find((entry) => entry.id === trackId)
    const item = track?.items.find((entry) => entry.id === itemId)

    const playhead = transport.positionSec
    let result
    try {
      switch (request.kind) {
        case 'track-name':
          if (!track) throw new EditError(`no such track: ${trackId}`)
          result = renameTrack(project, { trackId, name: request.name })
          break
        case 'track-mute':
          if (!track) throw new EditError(`no such track: ${trackId}`)
          result = setTrackMuted(project, { trackId, muted: request.muted })
          break
        case 'track-solo':
          if (!track) throw new EditError(`no such track: ${trackId}`)
          result = setTrackSolo(project, { trackId, solo: request.solo })
          break
        case 'track-delete':
          if (!track) throw new EditError(`no such track: ${trackId}`)
          result = deleteTrack(project, { trackId })
          break
        case 'master-fx':
          result = setMasterFx(project, { chain: request.chain })
          break
        case 'master-fader':
          result = setMasterFader(project, { masterFaderDb: request.masterFaderDb })
          break
        default:
          if (!track || !item) return
          result = applyClipEdit(project, track, item, request, playhead, trackId, itemId)
          if (!result) return
      }
      assertWithinLimits(result.project)
    } catch (caught) {
      setEditError(caught.message)
      return
    }
    setEditError('')
    if (!result.note) return
    update(() => result.project, result.note)
    if (request.kind === 'delete' || request.kind === 'track-delete') setSelection(null)
  }, [project, selection, transport.positionSec, update])

  // Starting playback needs a resumed AudioContext, which the browser only allows
  // after a gesture; the play button is that gesture.
  if (status === 'loading') {
    return h('div', { style: S.workbench }, h('p', { style: S.desc }, t('正在读取工程…')))
  }
  if (status === 'error') {
    return h('div', { style: S.workbench },
      h(Notice, { tone: 'error' }, error),
      h('div', null, h(Btn, { onClick: () => void reload() }, t('重试'))),
    )
  }

  const selectedTrack = selection ? project.tracks.find((entry) => entry.id === selection.trackId) : null
  const selectedItem = selectedTrack?.items.find((entry) => entry.id === selection.itemId) ?? null
  // The selected clip's material record carries the measured level (I-37), which
  // is the number the property panel shows first (I-38).
  const selectedMaterial = selectedItem
    ? materials.find((entry) => entry.id === selectedItem.material) ?? null
    : null
  const formats = availableFormats(project)
  const chosenFormat = formats.includes(exportFormat) ? exportFormat : formats[0]
  // The bus fader reads the stored field every render, so it never drifts from
  // what an export would apply.
  const faderDb = Number(project.masterFaderDb) || 0

  // Which chain the right-hand column is showing (I-07). The column is 220px and
  // lives beside the picture, so one list at a time. Since I-41 a track has no
  // chain of its own — effects live on clips or on the bus — so the only chain
  // that can open here is the bus.
  const fxEditor = fxTarget === 'master'
    ? { level: 'master', chain: project.masterFx ?? [], title: t('总线效果'), apply: (chain) => applyEdit({ kind: 'master-fx', chain }) }
    : null

  // The panel fills the view area and handles its own scrolling, so the header,
  // the preview row and the transport stay put while only the tracks scroll
  // (improvement plan 01, I-05).
  //
  // `data-conversation-composer-overlay` is the host's own switch for exactly
  // this case: while any element in the view carries it, the host lays the view
  // area over the whole column (`overflow: hidden`, `min-height: 0`) and lifts
  // the composer out of the flow, so the composer can no longer push the panel
  // down. Without it a multi-line draft grew the composer from 127px to 210px and
  // the workbench scrolled out from under the picture — that is the middle-wheel
  // complaint from improvement plan 01, not a stray wheel event.
  //
  // The attribute has to sit on the panel root: the host rule is a `:has()` on
  // the scroll body, and mounting it on a child changed nothing in the browser.
  // `height: 100%` only works because of that rule; on its own it resolved
  // against a content-sized container and grew the panel to 944px, under the
  // composer. The padding is the composer's own height, read after mount, so the
  // last track still clears it.
  return h('div', {
    'data-conversation-composer-overlay': '',
    style: {
      ...S.workbench,
      height: '100%',
      minHeight: 300,
      overflow: 'hidden',
      paddingBottom: composerInset,
      // The guide is a drawer over the clip bay, not over the whole window: it
      // explains the surface the person is looking at, so it must not cover the
      // session list or the right sidebar. `position: relative` is what gives it
      // this box to fill (2026-11-10).
      position: 'relative',
    },
  },
    // The header, the notices and the preview row are frozen: only the track
    // area scrolls, so the picture and the tools never scroll away (improvement
    // plan 01, I-05 — the "frozen pane" the user asked for).
    h('div', { style: S.header },
      h(Btn, { onClick: () => (dirty ? setLeavePrompt(true) : onBack()) }, t('← 返回')),
      h('h2', { style: S.title }, project.name),
      h('span', { style: S.chip }, `${project.tracks.length} ${t('轨')}`),
      h('span', { style: S.chip }, `${materials.length} ${t('个素材')}`),
      h('span', { style: { flex: 1 } }),
      // The round marks beside a button say what that button does when the label
      // cannot: 保存 vs 放弃 is a difference worth stating in place. The guide gets
      // a plain word instead, because a large panel and a tooltip are not the same
      // affordance and two question marks in a row read as a defect.
      h(HelpDot, { title: t('保存'), text: t('把当前草稿写进工程文件。不点保存，Agent 看到的是上次保存的版本。') }),
      h(Btn, {
        onClick: () => { cancel(); void save().then(() => setSaveError('')).catch((caught) => setSaveError(caught.message)) },
        disabled: !dirty,
        kind: dirty ? 'primary' : undefined,
        title: t('保存到工程文件'),
      }, t('保存')),
      dirty ? h(Btn, { onClick: () => { cancel(); void discard() }, title: t('放弃未保存的修改') }, t('放弃')) : null,
      h(Btn, { onClick: addToConversation, kind: (selection || range) ? 'primary' : undefined, disabled: !selection && !range }, t('添加到对话')),
      h(HelpDot, { title: t('添加到对话'), text: t('把选中的片段或轨道作为引用放进输入框。它不会自己发消息，你可以先引用，再给指令。举例：「这段台词换个音色」「重新编排这段旋律」。') }),
      // The bus fader (spec §10.2's 总推子). It sits beside the bus chain button
      // because the two act on the whole mix, and it stays a slider rather than a
      // number box so it can be pulled while the transport runs — the head of a
      // track carries the same control, and the two behave identically.
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, width: 180, alignSelf: 'center' } },
        h('span', { style: { ...S.mono, fontSize: 10, minWidth: 62, whiteSpace: 'nowrap' } },
          `${t('总线音量')} ${faderDb} dB`,
        ),
        h(Slider, {
          min: -60,
          max: 12,
          step: 0.5,
          value: faderDb,
          title: t('总线音量：整条混音的推子，作用在总线效果之前'),
          onChange: (value) => applyEdit({ kind: 'master-fader', masterFaderDb: value }),
        }),
      ),
      // The bus chain is one control, so it carries one plain title: a round
      // question mark beside a button whose label already says "bus" was noise
      // the person asked to remove (2026-11-10).
      h(Btn, {
        onClick: () => setFxTarget(fxTarget === 'master' ? null : 'master'),
        kind: fxTarget === 'master' ? 'primary' : undefined,
        title: t('总线效果：作用在母带推子之后的整条混音上'),
      }, t('总线')),
      h(Btn, { onClick: undo, disabled: !canUndo, title: 'Ctrl+Z' }, t('撤销')),
      h(Btn, { onClick: redo, disabled: !canRedo, title: 'Ctrl+Shift+Z' }, t('重做')),
      h('span', { style: { width: 8 } }),
      exporter.running
        ? h(Btn, { onClick: () => void exporter.cancel() }, t('取消导出'))
        : h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { width: 92 } },
            h(Select, {
              value: chosenFormat,
              onChange: setExportFormat,
              options: formats.map((format) => ({ value: format, label: format.toUpperCase() })),
            })),
          h(Switch, {
            checked: exportNormalize,
            onChange: setExportNormalize,
            label: t('导出时归一化'),
          }),
          h(Btn, {
            onClick: () => void exporter.start(chosenFormat, { normalize: exportNormalize }),
            kind: 'primary',
            title: t('用当前状态渲染成品，导出后工程不会自动保存。'),
          }, t('导出')),
        ),
      h(Btn, { onClick: () => setHelpOpen(true) }, t('帮助')),
    ),
    hasDraft ? h(Notice, null, t('有未保存的修改：导出使用当前状态，Agent 读取的是上次保存的版本。')) : null,
    editError ? h(Notice, { tone: 'error' }, editError) : null,
    saveError ? h(Notice, { tone: 'error' }, `${t('保存失败')}：${saveError} ${t('编辑仍在这里，可以重试。')}`) : null,
    mentionNotice ? h(Notice, null, mentionNotice) : null,
    exporter.error ? h(Notice, { tone: 'error' }, exporter.error) : null,
    exporter.job ? h(Notice, exporter.job.status === 'error' ? { tone: 'error' } : null, describeJob(exporter.job)) : null,
    // The preview row: picture on the left, properties on the right, the way
    // 剪映 puts them.
    //
    // The properties column was 220px, which cannot lay out an EQ band (type, Hz,
    // dB, Q, delete) — that is the crowding the person reported. It gets a fixed
    // width now and the picture takes whatever is left, which is the split they
    // asked for: "右侧固定加宽一些，剩余的给左侧的视频窗口区". A chain editor needs
    // more room than a gain field, so the width follows which one is open.
    //
    // `maxWidth` is the safety valve: on a panel squeezed by a wide right sidebar
    // the column yields instead of pushing the picture into a thumbnail.
    h('div', { style: { display: 'flex', gap: 10, minHeight: 0, flex: '0 0 auto', maxHeight: '38%' } },
      h('div', { style: { flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex' } },
        h(Preview, { root, projectId, project, transport }),
      ),
      h('div', {
        style: {
          flex: fxEditor ? '0 0 420px' : '0 0 340px',
          minWidth: 260,
          maxWidth: '55%',
          boxSizing: 'border-box',
          overflow: 'auto',
          border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px',
          background: C.softer,
        },
      },
        fxEditor
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              h(Btn, { onClick: () => setFxTarget(null), title: t('返回片段属性'), style: { padding: '1px 6px', fontSize: 11, lineHeight: 1.4 } }, '←'),
              h('span', { style: { fontSize: 11, color: C.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, fxEditor.title),
            ),
            h(FxEditor, {
              level: fxEditor.level,
              chain: fxEditor.chain,
              tracks: project.tracks,
              onChange: fxEditor.apply,
            }),
          )
          : h(ClipProperties, {
            selection,
            track: selectedTrack,
            item: selectedItem,
            material: selectedMaterial,
            // The chain editor needs every track, because a duck effect has to name
            // the track whose level drives it.
            tracks: project.tracks,
            onClear: clearSelection,
            onEdit: (request) => applyEdit({ ...request, trackId: selection?.trackId, itemId: selection?.itemId }),
          }),
      ),
    ),
    // The material bin sits between the property column and the timeline: it is a
    // reference list, not an editing surface, so it folds away when the person is
    // working on the tracks (improvement plan 03, I-40).
    h(MaterialBin, {
      root,
      projectId,
      materials,
      project,
      onDeleted: reload,
    }),
    h(Timeline, {
      root,
      projectId,
      project,
      materials,
      transport,
      onEdit: applyEdit,
      selection,
      onSelect: selectClip,
      onUndo: undo,
      onRedo: redo,
      range,
      onRange: setRange,
      onClearSelection: clearSelection,
    }),
    // The leave prompt is a modal, not a toast: it is the only moment the person
    // can lose an evening of edits, and a corner message is easy to miss
    // (improvement plan 05).
    leavePrompt ? h('div', {
      style: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
      },
    },
      h('div', {
        style: {
          background: surface, border: `1px solid ${C.border}`, borderRadius: 10,
          padding: 18, width: 380, display: 'flex', flexDirection: 'column', gap: 10,
        },
      },
        h('div', { style: { fontWeight: 600 } }, t('工程有未保存的修改')),
        h('div', { style: S.desc }, t('保存后离开，或放弃这些修改回到上次保存的版本。')),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(Btn, { onClick: () => setLeavePrompt(false) }, t('取消')),
          h(Btn, { onClick: async () => { cancel(); await discard(); setLeavePrompt(false); onBack() } }, t('放弃并离开')),
          h(Btn, {
            kind: 'primary',
            onClick: async () => {
              try {
                cancel()
                await save()
                setLeavePrompt(false)
                onBack()
              } catch (caught) {
                setSaveError(caught.message)
              }
            },
          }, t('保存并离开')),
        ),
      ),
    ) : null,
    h(HelpDrawer, { open: helpOpen, onClose: () => setHelpOpen(false), surface }),
  )
}

/**
 * The guide, in a drawer that slides over the clip bay.
 *
 * Deliberately short: it is read once by a person who wants to know who does
 * what, whether quitting loses their edits, and where the files land. Anything
 * longer stops being read.
 */
function HelpDrawer({ open, onClose, surface }) {
  if (!open) return null
  const section = (title, children) => h('section', { style: { marginBottom: 16 } },
    h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 5 } }, title),
    children,
  )
  const p = (text) => h('p', { style: { margin: '0 0 5px', fontSize: 12, lineHeight: 1.6 } }, text)
  const item = (text) => h('li', { style: { fontSize: 12, lineHeight: 1.6 } }, text)
  const row = (label, value) => h('tr', null,
    h('td', { style: { padding: '3px 8px 3px 0', color: C.muted, whiteSpace: 'nowrap', verticalAlign: 'top', fontSize: 11 } }, label),
    h('td', { style: { padding: '3px 0', fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' } }, value),
  )
  // Absolute, not fixed: the guide belongs to this View. A fixed drawer covered
  // the whole window and landed on top of the shell's right sidebar, which is a
  // different surface with its own panels (2026-11-10). The panel root is the
  // positioning box, so the drawer stops at the clip bay's own right edge.
  return h('div', { style: { position: 'absolute', inset: 0, zIndex: 55, display: 'flex', justifyContent: 'flex-end' } },
    h('div', { onClick: onClose, style: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.28)' } }),
    h('div', {
      style: {
        position: 'relative', width: 'min(430px, 92vw)', alignSelf: 'stretch', overflow: 'auto',
        background: surface, borderLeft: `1px solid ${C.border}`, padding: '14px 18px 30px',
        boxSizing: 'border-box', boxShadow: '-8px 0 24px rgba(0,0,0,0.16)',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 } },
        h('span', { style: { fontSize: 15, fontWeight: 650 } }, t('剪辑台使用说明')),
        h('span', { style: { flex: 1 } }),
        h(Btn, { onClick: onClose }, t('关闭')),
      ),
      section(t('一句话'), p(t('Agent 负责生成素材和批量修改；你负责试听、微调和拍板。'))),
      section(t('保存与草稿'),
        h('ul', { style: { margin: 0, paddingLeft: 18 } },
          item(t('你在这里改的是草稿，不会立刻写进工程文件。')),
          item(t('点「保存」才写进工程，Agent 才能看到你的修改。')),
          item(t('不点保存就离开，会弹窗提醒；选「放弃」就回到上次保存的版本。')),
          item(t('「导出」用的是当前状态，不是上次保存的版本。')),
        ),
      ),
      section(t('片段怎么调'),
        h('ul', { style: { margin: 0, paddingLeft: 18 } },
          item(t('点一下选中，右侧改增益、声像、淡入淡出。')),
          item(t('拖动片段移动；拖左右边缘裁剪；在播放头处点「分割」。')),
          item(t('M 静音这条轨，S 独奏这条轨；轨道只是分组，没有音量。')),
        ),
      ),
      section(t('添加到对话'),
        p(t('选中片段或轨道 → 点「添加到对话」→ 输入框出现引用 → 切到「对话」补充要求再发送。')),
        p(t('它不会自己发消息，只是把引用放进输入框。你可以先引用，再给指令，例如「这段台词换个音色」。')),
      ),
      // Where the files live belongs in the guide, not in the code: a person who
      // knows the layout can find, back up and clean up their own work.
      section(t('文件都在哪'),
        h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
          h('tbody', null,
            row(t('工程'), '.anyaudio/projects/<工程id>/project.json'),
            row(t('素材'), '.anyaudio/projects/<工程id>/materials/'),
            row(t('草稿'), '.anyaudio/projects/<工程id>/project.draft.json'),
            row(t('导出'), '.anyaudio/out/'),
            row(t('临时'), '.anyaudio/tmp/'),
          ),
        ),
        h('p', { style: { ...S.desc, marginTop: 6 } }, t('临时目录可以随时删；素材和工程别手动改，交给剪辑台或 Agent。')),
      ),
      section(t('快捷键'),
        h('ul', { style: { margin: 0, paddingLeft: 18 } },
          item(t('空格：播放 / 暂停')),
          item(t('Delete：删除选中片段')),
          item(t('Ctrl+D：复制选中片段')),
          item(t('Ctrl+Z / Ctrl+Shift+Z：撤销 / 重做')),
          item(t('Esc：取消选择')),
        ),
      ),
    ),
  )
}

export function ClipBayPanel({ useWorkspaces, sessionId, inputActions, useInput, locale }) {
  const snapshot = useWorkspaces ? useWorkspaces((value) => value) : undefined
  const workspace = workspaceForSession(snapshot?.items, sessionId)
  const [opened, setOpened] = useState(null)
  // The language preference lives in a module variable, so changing it does not
  // re-render anything on its own. The preference decides whether the shell's
  // locale is even consulted, and this counter turns either answer into a
  // repaint: without it an English user could be left on the first frame's
  // Chinese for the whole visit (2026-11-10).
  const [preference, setPreference] = useState(null)
  const [, setLangTick] = useState(0)
  // One way in for every language change: adopt it, tell the document, repaint.
  const adoptLanguage = (next) => {
    setLanguage(next)
    if (typeof document !== 'undefined') document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN'
    setLangTick((tick) => tick + 1)
  }

  // A different Session is a different workspace, and an open project belongs to
  // the old one — close it rather than let the shell keep writing to a folder the
  // page no longer points at.
  useEffect(() => { setOpened(null) }, [workspace?.path])

  // The panel has no config of its own; it borrows the settings page's language
  // preference so both halves of the plugin read the same way.
  useEffect(() => {
    let cancelled = false
    api('/state')
      .then((data) => {
        if (cancelled) return
        const value = data.config?.ui?.language || 'auto'
        setPreference(value)
        adoptLanguage(detectLanguage(data.config))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // "auto" means "whatever the shell is showing", and the shell publishes that as
  // its own locale service. Subscribing here is what makes the tab follow a
  // language change the same instant every other tab does, instead of waiting for
  // a reload. A pinned zh/en ignores it — that is what the person chose.
  useEffect(() => {
    if (!locale?.subscribe) return undefined
    const apply = () => {
      if (preference !== null && preference !== 'auto') return
      const next = languageFromLocale(locale)
      if (next) adoptLanguage(next)
    }
    apply()
    return locale.subscribe(apply)
  }, [locale, preference])

  if (!workspace?.path) {
    return h('div', { style: S.workbench },
      h('p', { style: S.desc }, t('这个会话还没有归属的工作区。先打开一个工作区，再回到剪辑台。')),
    )
  }
  if (opened) {
    return h(ProjectShell, {
      root: workspace.path,
      projectId: opened.id,
      onBack: () => setOpened(null),
      inputActions,
      useInput,
    })
  }
  return h(ProjectList, { root: workspace.path, onOpen: setOpened })
}
