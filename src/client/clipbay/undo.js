/**
 * Undo history (plan M5.6, spec §8.3).
 *
 * Two rules from the spec are structural here, not conventions:
 *
 *   ① Only a person's own edits are recorded. An Agent change arrives as a fresh
 *      project file and is loaded, never pushed — undoing it would throw away a
 *      round the user asked for.
 *   ② The stack dies with the panel. It lives in the component that owns it and
 *      is never persisted, so switching to 对话 and back gives an empty stack.
 *
 * Pure so the semantics can be tested without a browser.
 */

/** A history holds snapshots, newest last. */
export function createHistory() {
  return { past: [], future: [] }
}

/**
 * Record that `previous` is the state before an edit.
 *
 * A new edit invalidates the redo trail: after undoing twice and editing again,
 * the two undone states are unreachable, which is what every editor does.
 */
export function pushHistory(history, previous, limit = 100) {
  const past = [...history.past, previous]
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    future: [],
  }
}

export function canUndo(history) {
  return history.past.length > 0
}

export function canRedo(history) {
  return history.future.length > 0
}

/** Step back: return the state to restore and the history to keep using. */
export function undo(history, current) {
  if (history.past.length === 0) return { project: current, history }
  const previous = history.past[history.past.length - 1]
  return {
    project: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
    },
  }
}

/** Step forward again, along the trail the undos left. */
export function redo(history, current) {
  if (history.future.length === 0) return { project: current, history }
  const [next, ...rest] = history.future
  return {
    project: next,
    history: { past: [...history.past, current], future: rest },
  }
}

/**
 * The history after an Agent change was loaded from disk: the trail is dropped,
 * because every snapshot in it refers to an arrangement that no longer exists.
 */
export function resetHistory() {
  return createHistory()
}
