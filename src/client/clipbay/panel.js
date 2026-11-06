/**
 * Clip bay — the multichannel editing surface.
 *
 * Plan M4: the tab exists, it opens, and it lists the projects of the workspace
 * the user is currently looking at. Editing arrives in M5, so opening a project
 * shows a shell that names it rather than pretending to have a timeline.
 *
 * The workspace is resolved the same way image-gen and mnemon do it: the session
 * shown in the main view decides, and a session with no workspace falls back to
 * the first one in the registry. The host re-checks the path against its own
 * registry, so a wrong guess here fails closed (403) rather than reading a folder
 * this page has no business reading.
 */
import { h, useState, useEffect, useCallback, S, Btn, Notice } from '../ui.js'
import { api } from '../api.js'
import { t, detectLanguage, setLanguage } from '../i18n.js'
import { useProject } from './state.js'
import { usePlayback } from './audio.js'
import { useAutosave } from './saving.js'
import { Timeline } from './timeline.js'
import { ClipProperties } from './properties.js'
import {
  moveClip, trimClip, splitClip, deleteClip, duplicateClip,
  setClipGain, setClipPan, setClipFades, setClipMuted, assertWithinLimits,
  renameTrack, setTrackVolume, setTrackPan, setTrackMuted, setTrackSolo, deleteTrack,
  EditError,
} from './edit.js'

export const CLIP_BAY_ID = 'clip-bay'

/**
 * Pick the workspace the page should read.
 *
 * `useWorkspaces` and `useSessions` are standard props of a Conversation View,
 * so they are always present; the defensive reads only guard against a
 * registry that is still loading.
 */
function pickWorkspace(useWorkspaces, useSessions) {
  const snapshot = useWorkspaces ? useWorkspaces((value) => value) : undefined
  const sessionState = useSessions ? useSessions((value) => value) : undefined
  const items = Array.isArray(snapshot?.items) ? snapshot.items : []
  if (items.length === 0) return null
  const currentSessionId = sessionState?.current
  if (currentSessionId) {
    const matched = items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(currentSessionId))
    if (matched) return matched
  }
  return items[0]
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
    return h('div', { style: S.page },
      h(Notice, { tone: 'error' }, error),
      h('div', null, h(Btn, { onClick: () => void reload() }, t('重试'))),
    )
  }
  if (!projects) return h('div', { style: S.page }, h('p', { style: S.desc }, t('正在读取工程…')))
  if (projects.length === 0) {
    return h('div', { style: S.page },
      h('p', { style: S.desc }, t('这个工作区还没有工程。在会话里让 Agent 建一个：说「新建一个剪辑台工程」即可。')),
    )
  }
  return h('div', { style: S.page },
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

function ProjectShell({ root, projectId, onBack }) {
  const { status, error, project, materials, reload, update, undo, redo, canUndo, canRedo, markSaved } = useProject(root, projectId)
  const transport = usePlayback(root, projectId)
  const setTransportProject = transport.setProject
  const [selection, setSelection] = useState(null)
  const [editError, setEditError] = useState('')
  const [saveError, setSaveError] = useState('')

  // Debounced write plus a flush on unmount: switching to 对话 destroys this
  // component, and the last few hundred milliseconds must still reach the file.
  useAutosave(root, project, {
    enabled: Boolean(project),
    onSaved: () => { setSaveError(''); markSaved() },
    onError: (message) => setSaveError(message),
  })

  // The transport schedules from the project it is handed, so it must see the
  // current arrangement rather than whatever was loaded when it mounted.
  useEffect(() => {
    if (project) setTransportProject(project)
  }, [project, setTransportProject])

  const selectClip = useCallback((trackId, itemId) => {
    setSelection(itemId ? { trackId, itemId } : null)
  }, [])

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
    return h('div', { style: S.page }, h('p', { style: S.desc }, t('正在读取工程…')))
  }
  if (status === 'error') {
    return h('div', { style: S.page },
      h(Notice, { tone: 'error' }, error),
      h('div', null, h(Btn, { onClick: () => void reload() }, t('重试'))),
    )
  }

  const selectedTrack = selection ? project.tracks.find((entry) => entry.id === selection.trackId) : null
  const selectedItem = selectedTrack?.items.find((entry) => entry.id === selection.itemId) ?? null

  return h('div', { style: S.page },
    h('div', { style: S.header },
      h(Btn, { onClick: onBack }, t('← 返回')),
      h('h2', { style: S.title }, project.name),
      h('span', { style: S.chip }, `${project.tracks.length} ${t('轨')}`),
      h('span', { style: S.chip }, `${materials.length} ${t('个素材')}`),
      h('span', { style: { flex: 1 } }),
      h(Btn, { onClick: undo, disabled: !canUndo, title: 'Ctrl+Z' }, t('撤销')),
      h(Btn, { onClick: redo, disabled: !canRedo, title: 'Ctrl+Shift+Z' }, t('重做')),
    ),
    editError ? h(Notice, { tone: 'error' }, editError) : null,
    saveError ? h(Notice, { tone: 'error' }, `${t('保存失败')}：${saveError} ${t('编辑仍在这里，可以重试。')}`) : null,
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
    }),
    h(ClipProperties, {
      selection,
      track: selectedTrack,
      item: selectedItem,
      onEdit: (request) => applyEdit({ ...request, trackId: selection?.trackId, itemId: selection?.itemId }),
    }),
  )
}

export function ClipBayPanel({ useWorkspaces, useSessions }) {
  const workspace = pickWorkspace(useWorkspaces, useSessions)
  const [opened, setOpened] = useState(null)

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
    return h('div', { style: S.page },
      h('p', { style: S.desc }, t('还没有打开任何工作区。先在左侧打开一个工作区，再回到剪辑台。')),
    )
  }
  if (opened) {
    return h(ProjectShell, { root: workspace.path, projectId: opened.id, onBack: () => setOpened(null) })
  }
  return h(ProjectList, { root: workspace.path, onOpen: setOpened })
}
