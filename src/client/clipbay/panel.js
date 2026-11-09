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
import { h, useState, useEffect, useCallback, S, C, Btn, Notice, Select, Slider, Switch } from '../ui.js'
import { api } from '../api.js'
import { t, detectLanguage, setLanguage } from '../i18n.js'
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
  const [mentionNotice, setMentionNotice] = useState('')
  // Which effect chain the right-hand column is showing, if any (I-07). Null means
  // "show the selected clip": the panel is one column, so opening a track or the
  // bus chain replaces the clip properties rather than stacking three lists in
  // 220px.
  const [fxTarget, setFxTarget] = useState(null)
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

  // Debounced draft write plus a flush on unmount: switching to 对话 destroys
  // this component, and the last few hundred milliseconds must still reach the
  // draft. Gated on `dirty` rather than on "a project is loaded": mounting the
  // panel must not write a draft the person has not changed.
  const { flush } = useDraftAutosave(root, project, {
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
      // 保存 is the commit point (improvement plan 05): edits go to the draft, and
      // only this writes project.json. 放弃 throws the draft away.
      h(Btn, {
        onClick: () => { void save().then(() => setSaveError('')).catch((caught) => setSaveError(caught.message)) },
        disabled: !dirty,
        kind: dirty ? 'primary' : undefined,
        title: t('保存到工程文件'),
      }, t('保存')),
      dirty ? h(Btn, { onClick: () => { void discard() }, title: t('放弃未保存的修改') }, t('放弃')) : null,
      h(Btn, { onClick: addToConversation, kind: (selection || range) ? 'primary' : undefined, disabled: !selection && !range }, t('添加到对话')),
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
          }, t('导出')),
        ),
    ),
    hasDraft ? h(Notice, null, t('有未保存的修改：导出会使用当前画面，Agent 读到的是上次保存的版本。')) : null,
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
          background: 'rgb(32,32,36)', border: `1px solid ${C.border}`, borderRadius: 10,
          padding: 18, width: 380, display: 'flex', flexDirection: 'column', gap: 10,
        },
      },
        h('div', { style: { fontWeight: 600 } }, t('工程有未保存的修改')),
        h('div', { style: S.desc }, t('保存后离开，或放弃这些修改回到上次保存的版本。')),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
          h(Btn, { onClick: () => setLeavePrompt(false) }, t('取消')),
          h(Btn, { onClick: async () => { await discard(); setLeavePrompt(false); onBack() } }, t('放弃并离开')),
          h(Btn, {
            kind: 'primary',
            onClick: async () => {
              try {
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
