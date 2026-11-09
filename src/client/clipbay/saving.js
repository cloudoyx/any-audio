/**
 * Saving (plan M5.7, spec §8.4; draft model in improvement plan 05).
 *
 * A person editing the timeline is auditioning, so an edit is not a commit: it
 * goes to `project.draft.json`, and only `保存` writes project.json. The draft is
 * still written on a debounce (and flushed on unmount) so a crash or a tab switch
 * cannot lose the work — the difference is what the Agent reads, not whether the
 * bytes reach disk.
 *
 *   ① every edit schedules a draft write 250 ms later, collapsing a burst;
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

export function draftUrl(root, projectId) {
  return `/clipbay/draft?root=${encodeURIComponent(root)}&id=${encodeURIComponent(projectId)}`
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

/** Write the unsaved arrangement. Never touches project.json. */
export async function saveDraft(root, project) {
  await api(draftUrl(root, project.id), {
    method: 'POST',
    body: { project: serializeProject(project) },
  })
}

/**
 * Wire a project to debounced, flush-on-unmount draft saving.
 *
 * `onError` is called with a message when a write fails; the in-memory project is
 * left untouched so the user can retry rather than losing the edit.
 */
export function useDraftAutosave(root, project, { enabled = true, onError } = {}) {
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
    return saveDraft(root, queued)
      .catch((caught) => { if (mountedRef.current) onError?.(caught.message) })
  }, [root, onError])

  /**
   * Drop the pending write.
   *
   * 保存 and 放弃 both delete the draft, and the unmount flush would otherwise
   * write it straight back — the panel unmounts right after either action, so the
   * queued project would resurrect a draft that was just deleted.
   */
  const cancel = useCallback(() => {
    pendingRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = 0
    }
  }, [])

  useEffect(() => {
    // A disabled autosave must also drop anything already scheduled: 保存 and
    // 放弃 flip `dirty` off while a write from the previous render is still in
    // the timer, and that write would resurrect the draft right after it was
    // deleted (measured: the draft came back after 放弃).
    if (!enabled || !project) {
      cancel()
      return undefined
    }
    pendingRef.current = project
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = 0
      flush()
    }, SAVE_DEBOUNCE_MS)
    return undefined
  }, [enabled, project, flush, cancel])

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
      void saveDraft(root, queued).catch(() => {})
    }
    mountedRef.current = false
  }, [root])

  return { flush, cancel }
}
