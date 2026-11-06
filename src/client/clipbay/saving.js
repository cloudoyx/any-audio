/**
 * Saving (plan M5.7, spec §8.4).
 *
 * The panel unmounts when the user switches tabs, so a debounce alone would lose
 * whatever was typed in the last few hundred milliseconds. Hence two behaviours:
 *
 *   ① every edit schedules a write 250 ms later, collapsing a burst of edits into
 *      one request;
 *   ② unmount flushes synchronously — the request is already on its way, and an
 *      aborted fetch would drop the edit exactly when the user leaves.
 *
 * There is no version compare and no lock: the editor and the Agent take turns,
 * never overlap (spec §8.4).
 */
import { useCallback, useEffect, useRef } from 'react'
import { api } from '../api.js'
import { serializeProject } from './serialize.js'

export const SAVE_DEBOUNCE_MS = 250

/**
 * Where a save goes. `root` and `id` must be in the query string — the host
 * resolves them from there and never trusts a path from the body, so putting them
 * in the JSON is a silent 400.
 */
export function saveUrl(root, projectId) {
  return `/clipbay/project?root=${encodeURIComponent(root)}&id=${encodeURIComponent(projectId)}`
}

/**
 * Save one project.
 *
 * `note` stays empty: the history entry was already appended by the edit that
 * caused the write, and the host appends only what the caller passes.
 */
export async function saveProject(root, project) {
  await api(saveUrl(root, project.id), {
    method: 'POST',
    body: { project: serializeProject(project) },
  })
}

/**
 * Wire a project to debounced, flush-on-unmount saving.
 *
 * `onError` is called with a message when a write fails; the in-memory project is
 * left untouched so the user can retry rather than losing the edit.
 */
export function useAutosave(root, project, { enabled = true, onSaved, onError } = {}) {
  const timerRef = useRef(0)
  const pendingRef = useRef(null)
  const mountedRef = useRef(true)

  const flush = useCallback(() => {
    const queued = pendingRef.current
    if (!queued) return Promise.resolve()
    pendingRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = 0
    }
    // The returned promise matters to callers that need the file on disk before
    // doing something else — an export renders from project.json, not from memory.
    return saveProject(root, queued)
      .then(() => { if (mountedRef.current) onSaved?.() })
      .catch((caught) => { if (mountedRef.current) onError?.(caught.message) })
  }, [root, onSaved, onError])

  useEffect(() => {
    if (!enabled || !project) return undefined
    pendingRef.current = project
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = 0
      flush()
    }, SAVE_DEBOUNCE_MS)
    return undefined
  }, [enabled, project, flush])

  // The unmount path is the one that matters: the tab switch destroys this
  // component, so the last write has to start here rather than in a later render.
  useEffect(() => () => {
    const queued = pendingRef.current
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = 0
    }
    if (queued) {
      pendingRef.current = null
      void saveProject(root, queued).catch(() => {})
    }
    mountedRef.current = false
  }, [root])

  return { flush }
}
