"use client";

import { useCallback, useState } from "react";
import { createUndoState, pushUndoState, redoState, resetUndoState, undoState } from "@/lib/undo-stack";

export type UndoAction = "init" | "commit" | "undo" | "redo" | "reset";

/**
 * React wrapper around `lib/undo-stack.ts` — the pure logic lives there so it can be tested
 * without a component; this just holds it in state and exposes `Ctrl/Cmd+Z`-shaped actions.
 *
 * `action` tags *why* `present` just changed, so a caller's `useEffect(() => ..., [present,
 * action])` can tell a real edit (commit/undo/redo — save it) from `reset` (accepting an external
 * change, e.g. the two-tab "Reload" — don't write it straight back) or the initial mount (`init`
 * — nothing to save yet).
 */
export function useUndoStack<T>(initial: T) {
  const [state, setState] = useState(() => createUndoState(initial));
  const [action, setAction] = useState<UndoAction>("init");

  const commit = useCallback((next: T) => {
    setState((current) => pushUndoState(current, next));
    setAction("commit");
  }, []);
  const undo = useCallback(() => {
    setState((current) => undoState(current));
    setAction("undo");
  }, []);
  const redo = useCallback(() => {
    setState((current) => redoState(current));
    setAction("redo");
  }, []);
  const reset = useCallback((next: T) => {
    setState((current) => resetUndoState(current, next));
    setAction("reset");
  }, []);

  return {
    present: state.present,
    action,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    commit,
    undo,
    redo,
    reset
  };
}
