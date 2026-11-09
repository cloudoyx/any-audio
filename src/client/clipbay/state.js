/**
 * The editor's view of one project (plan M5.1, M5.6, M5.7).
 *
 * `project` here is exactly what project.json holds — arrangement only. Playhead,
 * selection, zoom and scroll position are view state and live in the components
 * that own them, so there is no path by which they reach the file (spec §6.8).
 *
 * Undo lives here rather than in a separate store because an edit and its undo
 * entry are the same event: `update` records the arrangement it replaced, and
 * `undo`/`redo` move through those snapshots without touching `history`.
 *
 * The current project and the undo trail are held in refs as well as state, so
 * an edit handler always sees the latest values without a stale closure and
 * without doing work inside a state updater (which React may run twice).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { contentEndSec } from './serialize.js'
import { saveProject } from './saving.js'
import { createHistory, pushHistory, canUndo, canRedo, undo as undoStep, redo as redoStep } from './undo.js'

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function draftUrl(root, projectId) {
  return `/clipbay/draft?root=${encodeURIComponent(root)}&id=${encodeURIComponent(projectId)}`
}

/**
 * Load a project and its material index, then expose a mutate-somehow API.
 *
 * `update(mutator, note)` hands the mutator a deep copy so a component that
 * forgets to clone cannot corrupt what is on screen; `note` is the sentence the
 * file's history records, and is the only reason history grows (spec §6.7).
 */
export function useProject(root, projectId) {
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [project, setProject] = useState(null)
  const [materials, setMaterials] = useState([])
  const [dirty, setDirty] = useState(false)
  const [hasDraft, setHasDraft] = useState(false)
  const [trailVersion, setTrailVersion] = useState(0)

  const projectRef = useRef(null)
  const trailRef = useRef(createHistory())

  const adopt = useCallback((next) => {
    projectRef.current = next
    setProject(next)
  }, [])

  const reload = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      // The draft is the person's unsaved work (improvement plan 05). It wins on
      // open: a crash must not silently throw away an evening of edits, and the
      // panel says plainly that the arrangement on screen is not saved yet.
      const [data, draftData] = await Promise.all([
        api(`/clipbay/project?root=${encodeURIComponent(root)}&id=${encodeURIComponent(projectId)}`),
        api(draftUrl(root, projectId)).catch(() => ({ draft: null })),
      ])
      const draft = draftData?.draft ?? null
      adopt(draft ?? data.project)
      setMaterials(data.materials ?? [])
      setDirty(Boolean(draft))
      setHasDraft(Boolean(draft))
      // Whatever the file now holds is the new baseline; the trail behind it
      // describes an arrangement that no longer exists.
      trailRef.current = createHistory()
      setTrailVersion((value) => value + 1)
      setStatus('ready')
    } catch (caught) {
      setError(caught.message)
      setStatus('error')
    }
  }, [root, projectId, adopt])

  useEffect(() => { void reload() }, [reload])

  const update = useCallback((mutator, note) => {
    const current = projectRef.current
    if (!current) return
    const draft = structuredClone(current)
    const next = mutator(draft) ?? draft
    next.durationSec = contentEndSec(next)
    if (note) {
      next.history = [...next.history, { at: nowIso(), by: 'user', note }]
    }
    trailRef.current = pushHistory(trailRef.current, current)
    setTrailVersion((value) => value + 1)
    adopt(next)
    setDirty(true)
  }, [adopt])

  /** Step back one human edit. Nothing is written until the debounce fires. */
  const undo = useCallback(() => {
    const current = projectRef.current
    if (!current) return
    const step = undoStep(trailRef.current, current)
    if (step.project === current) return
    trailRef.current = step.history
    setTrailVersion((value) => value + 1)
    adopt(step.project)
    setDirty(true)
  }, [adopt])

  const redo = useCallback(() => {
    const current = projectRef.current
    if (!current) return
    const step = redoStep(trailRef.current, current)
    if (step.project === current) return
    trailRef.current = step.history
    setTrailVersion((value) => value + 1)
    adopt(step.project)
    setDirty(true)
  }, [adopt])

  /**
   * Commit the draft: write project.json, then delete the draft.
   *
   * The order matters — a crash between the two leaves a draft that equals the
   * saved file, which the next open simply adopts; the reverse order would lose
   * the work.
   */
  const save = useCallback(async () => {
    const current = projectRef.current
    if (!current) return
    await saveProject(root, current)
    await api(draftUrl(root, projectId), { method: 'DELETE' })
    setDirty(false)
    setHasDraft(false)
  }, [root, projectId])

  /** Throw the draft away and go back to the last saved arrangement. */
  const discard = useCallback(async () => {
    // Clear `dirty` first: reload adopts the saved project, and the autosave
    // effect would otherwise schedule a write of that project as a fresh draft
    // the moment it lands (measured: the draft came back right after 放弃).
    setDirty(false)
    await api(draftUrl(root, projectId), { method: 'DELETE' })
    await reload()
  }, [root, projectId, reload])

  // `trailVersion` is read so the flags recompute whenever the trail changed.
  void trailVersion

  return {
    status,
    error,
    project,
    materials,
    dirty,
    hasDraft,
    reload,
    update,
    undo,
    redo,
    save,
    discard,
    canUndo: canUndo(trailRef.current),
    canRedo: canRedo(trailRef.current),
  }
}

/** Materials by id, for the drawing code that needs duration and kind. */
export function indexMaterials(materials) {
  const map = new Map()
  for (const material of materials ?? []) map.set(material.id, material)
  return map
}
