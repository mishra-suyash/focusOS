#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/undo-stack.ts (plan/05.FocusOS-v2-Plan-Day-Timeline.md DP2's undo/redo
 * requirement) — same pattern as scripts/verify-timeline.ts.
 */
import { createUndoState, pushUndoState, redoState, resetUndoState, undoState, type UndoState } from "../lib/undo-stack";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

{
  let state = createUndoState("a");
  state = pushUndoState(state, "b");
  state = pushUndoState(state, "c");
  check("pushUndoState: present is the latest value", state.present === "c");
  check("pushUndoState: past accumulates prior values in order", state.past.join(",") === "a,b");

  state = undoState(state);
  check("undoState: present reverts to the prior value", state.present === "b");
  check("undoState: future gains the undone value", state.future.join(",") === "c");

  state = undoState(state);
  check("undoState: can undo twice back to the initial value", state.present === "a" && state.past.length === 0);

  state = undoState(state);
  check("undoState: undoing past the start is a no-op", state.present === "a" && state.past.length === 0);

  state = redoState(state);
  state = redoState(state);
  check("redoState: replays undone values back in order", state.present === "c" && state.future.length === 0);

  state = redoState(state);
  check("redoState: redoing past the end is a no-op", state.present === "c" && state.future.length === 0);
}

{
  // A fresh commit after an undo discards the redo branch — same as any text editor.
  let state = createUndoState("a");
  state = pushUndoState(state, "b");
  state = pushUndoState(state, "c");
  state = undoState(state);
  state = pushUndoState(state, "d");
  check("pushUndoState: a commit after undo clears future", state.present === "d" && state.future.length === 0);
  check("pushUndoState: a commit after undo keeps the undone-to point in past", state.past.join(",") === "a,b");
}

{
  // History is capped at 50 steps.
  let state = createUndoState(0);
  for (let i = 1; i <= 60; i += 1) state = pushUndoState(state, i);
  check("pushUndoState: past is capped at 50 entries", state.past.length === 50);
  check("pushUndoState: the cap drops the oldest entries first", state.past[0] === 10);
}

{
  // resetUndoState swaps `present` without disturbing past/future or counting as an undo step.
  let state: UndoState<string> = createUndoState("a");
  state = pushUndoState(state, "b");
  state = resetUndoState(state, "external");
  check("resetUndoState: present becomes the external value", state.present === "external");
  check("resetUndoState: past is untouched", state.past.join(",") === "a");
  state = undoState(state);
  check("resetUndoState: an undo right after still reverts to the last real edit", state.present === "a");
}

if (failures.length > 0) {
  console.error(`verify-undo-stack: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-undo-stack: all lib/undo-stack.ts checks passed.");
