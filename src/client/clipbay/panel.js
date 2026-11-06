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

function ProjectShell({ root, projectId, onBack }) {
  const { status, error, project, materials, reload } = useProject(root, projectId)

  if (status === 'loading') {
    return h('div', { style: S.page }, h('p', { style: S.desc }, t('正在读取工程…')))
  }
  if (status === 'error') {
    return h('div', { style: S.page },
      h(Notice, { tone: 'error' }, error),
      h('div', null, h(Btn, { onClick: () => void reload() }, t('重试'))),
    )
  }

  // M5.1 loads and serializes the project; the timeline that edits it arrives
  // with the rest of M5. Until then the shell proves the file round-trips.
  return h('div', { style: S.page },
    h('div', { style: S.header },
      h(Btn, { onClick: onBack }, t('← 返回')),
      h('h2', { style: S.title }, project.name),
      h('span', { style: S.chip }, `${project.tracks.length} ${t('轨')}`),
      h('span', { style: S.chip }, formatDuration(project.durationSec)),
      h('span', { style: S.chip }, `${materials.length} ${t('个素材')}`),
    ),
    h('div', { style: { ...S.card, borderStyle: 'dashed', alignItems: 'center', padding: '40px 14px' } },
      h('p', { style: S.desc }, t('时间轴还没做，下一步就有了。')),
    ),
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
