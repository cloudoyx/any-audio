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
import { h, useState, useEffect, useCallback, S, C, Btn, Notice, Select, Switch } from '../ui.js'
import { api } from '../api.js'
import { t, detectLanguage, setLanguage } from '../i18n.js'
import { useProject } from './state.js'
import { usePlayback } from './audio.js'
import { useAutosave } from './saving.js'
import { useExport, availableFormats, describeJob } from './exporter.js'
import { Timeline } from './timeline.js'
import { Preview } from './preview.js'
import { ClipProperties } from './properties.js'
import { buildMention, appendToDraft } from './mention.js'
import {
  moveClip, trimClip, splitClip, deleteClip, duplicateClip,
  setClipGain, setClipPan, setClipFades, setClipMuted, assertWithinLimits,
  renameTrack, setTrackVolume, setTrackPan, setTrackMuted, setTrackSolo, deleteTrack,
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

function ProjectList({ root, onOpen }) {
  const [projects, setProjects] = useState(null)
  const [error, setError] = useState('')

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
    return h('div', { style: S.workbench },
      h('p', { style: S.desc }, t('这个工作区还没有工程。在会话里让 Agent 建一个：说「新建一个剪辑台工程」即可。')),
    )
  }
  return h('div', { style: S.workbench },
    h('div', { style: S.header },
      h('h2', { style: S.title }, t('剪辑台')),
      h('span', { style: S.chip }, `${projects.length} ${t('个工程')}`),
      h('span', { style: { flex: 1 } }),
      h(Btn, { onClick: () => void reload() }, t('刷新')),
    ),
    h('div', { style: S.list }, projects.map((project) => h('button', {
      key: project.id,
      type: 'button',
      onClick: () => onOpen(project),
      style: { ...S.item, cursor: 'pointer', textAlign: 'left', background: 'transparent', color: 'inherit', fontSize: 13 },
    },
      h('div', { style: S.itemHead },
        h('span', { style: { fontWeight: 600 } }, project.name),
        project.hasVideo ? h('span', { style: S.chip }, t('含视频')) : null,
        h('span', { style: S.chip }, `${project.trackCount} ${t('轨')}`),
        h('span', { style: S.chip }, formatDuration(project.durationSec)),
      ),
      h('div', { style: S.mono }, project.id),
    ))),
  )
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
  const { status, error, project, materials, dirty, reload, update, undo, redo, canUndo, canRedo, markSaved } = useProject(root, projectId)
  const transport = usePlayback(root, projectId)
  const setTransportProject = transport.setProject
  const [selection, setSelection] = useState(null)
  const [range, setRange] = useState(null)
  const [editError, setEditError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [mentionNotice, setMentionNotice] = useState('')
  const composerInset = useComposerInset()
  // Export settings live in the panel, not in project.json: they describe this
  // one export, and spec §6.8 keeps one-off UI state out of the project.
  const [exportFormat, setExportFormat] = useState('')
  const [exportNormalize, setExportNormalize] = useState(false)
  // Read the draft here, at the top level, so 添加到对话 only has to append to a
  // value it already has. Both the hook and its state are stable, so the read
  // does not make the click handler stale.
  const useInputState = typeof useInput === 'function' ? useInput : useNoInput
  const draft = useInputState((state) => state)?.draft ?? ''

  // Debounced write plus a flush on unmount: switching to 对话 destroys this
  // component, and the last few hundred milliseconds must still reach the file.
  // Autosave is gated on `dirty` rather than on "a project is loaded": mounting
  // the panel must not write a file the person has not changed, because that
  // write would put this panel's copy over whatever the Agent just wrote.
  const { flush } = useAutosave(root, project, {
    enabled: Boolean(project) && dirty,
    onSaved: () => { setSaveError(''); markSaved() },
    onError: (message) => setSaveError(message),
  })

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
        case 'track-volume':
          if (!track) throw new EditError(`no such track: ${trackId}`)
          result = setTrackVolume(project, { trackId, volumeDb: request.volumeDb })
          break
        case 'track-pan':
          if (!track) throw new EditError(`no such track: ${trackId}`)
          result = setTrackPan(project, { trackId, pan: request.pan })
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
  const formats = availableFormats(project)
  const chosenFormat = formats.includes(exportFormat) ? exportFormat : formats[0]

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
    },
  },
    // The header, the notices and the preview row are frozen: only the track
    // area scrolls, so the picture and the tools never scroll away (improvement
    // plan 01, I-05 — the "frozen pane" the user asked for).
    h('div', { style: S.header },
      h(Btn, { onClick: onBack }, t('← 返回')),
      h('h2', { style: S.title }, project.name),
      h('span', { style: S.chip }, `${project.tracks.length} ${t('轨')}`),
      h('span', { style: S.chip }, `${materials.length} ${t('个素材')}`),
      h('span', { style: { flex: 1 } }),
      h(Btn, { onClick: addToConversation, kind: (selection || range) ? 'primary' : undefined, disabled: !selection && !range }, t('添加到对话')),
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
          }, t('导出')),
        ),
    ),
    editError ? h(Notice, { tone: 'error' }, editError) : null,
    saveError ? h(Notice, { tone: 'error' }, `${t('保存失败')}：${saveError} ${t('编辑仍在这里，可以重试。')}`) : null,
    mentionNotice ? h(Notice, null, mentionNotice) : null,
    exporter.error ? h(Notice, { tone: 'error' }, exporter.error) : null,
    exporter.job ? h(Notice, exporter.job.status === 'error' ? { tone: 'error' } : null, describeJob(exporter.job)) : null,
    // The preview row: picture on the left, clip properties on the right, the way
    // 剪映 puts them. The row takes at most 38% of the panel so the tracks keep
    // the rest.
    h('div', { style: { display: 'flex', gap: 10, minHeight: 0, flex: '0 0 auto', maxHeight: '38%' } },
      h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex' } },
        h(Preview, { root, projectId, project, transport }),
      ),
      h('div', {
        style: {
          // 220px beside the picture, but it gives way before the picture does.
          // `flex-shrink` alone does not achieve that: the preview is `flex: 1 1 0`,
          // so it happily absorbs the leftover space and the row never overflows,
          // which leaves this column at 220px and the video a 124px thumbnail when
          // a wide right sidebar squeezes the workstation to ~390px. `maxWidth`
          // is what actually yields: on a wide panel 45% is far more than 220px so
          // nothing changes, and on a narrow one the column shrinks to its 132px
          // floor while the picture keeps the rest.
          flex: '0 1 220px', minWidth: 132, maxWidth: '45%', boxSizing: 'border-box',
          overflow: 'auto',
          border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px',
          background: C.softer,
        },
      },
        h(ClipProperties, {
          selection,
          track: selectedTrack,
          item: selectedItem,
          onClear: clearSelection,
          onEdit: (request) => applyEdit({ ...request, trackId: selection?.trackId, itemId: selection?.itemId }),
        }),
      ),
    ),
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
  )
}

export function ClipBayPanel({ useWorkspaces, sessionId, inputActions, useInput }) {
  const snapshot = useWorkspaces ? useWorkspaces((value) => value) : undefined
  const workspace = workspaceForSession(snapshot?.items, sessionId)
  const [opened, setOpened] = useState(null)

  // A different Session is a different workspace, and an open project belongs to
  // the old one — close it rather than let the shell keep writing to a folder the
  // page no longer points at.
  useEffect(() => { setOpened(null) }, [workspace?.path])

  // The panel has no config of its own; it borrows the settings page's language
  // preference so both halves of the plugin read the same way. Rendering is not
  // held back for it — the first frame uses the current language.
  useEffect(() => {
    let cancelled = false
    api('/state')
      .then((data) => { if (!cancelled) setLanguage(detectLanguage(data.config)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

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
