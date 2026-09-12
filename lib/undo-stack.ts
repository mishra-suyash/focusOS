/**
 * plan/FocusOS-v2-Plan-Day-Timeline.md §5, DP2 — "Undo / redo ... Session-local stack, 50 steps."
 * Generic and pure (no React) so it's testable the same way as `lib/timeline.ts`'s helpers; the
 * thin `hooks/use-undo-stack.ts` wrapper is the only React-aware part.
 */

export interface UndoState<T> {
  past: T[];
  present: T;
  future: T[];
}

const MAX_HISTORY = 50;

export function createUndoState<T>(initial: T): UndoState<T> {
  return { past: [], present: initial, future: [] };
}

/** Commits a new state as a fresh undo step. A commit after an undo (i.e. with a non-empty `future`) discards that redo branch — the same "typing after undo erases redo history" behavior as any text editor. */
export function pushUndoState<T>(state: UndoState<T>, next: T): UndoState<T> {
  return { past: [...state.past, state.present].slice(-MAX_HISTORY), present: next, future: [] };
}

export function undoState<T>(state: UndoState<T>): UndoState<T> {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] };
}

export function redoState<T>(state: UndoState<T>): UndoState<T> {
  if (state.future.length === 0) return state;
  const [next, ...rest] = state.future;
  return { past: [...state.past, state.present], present: next, future: rest };
}

/** Replaces `present` in place without pushing an undo step — for accepting a genuine external change (another tab, per §6's two-tab rule) that shouldn't itself become something the user can "undo" back out of. */
export function resetUndoState<T>(state: UndoState<T>, next: T): UndoState<T> {
  return { ...state, present: next };
}
