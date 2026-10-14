"use client";

import { useFocusSession } from "@/components/focus-session-provider";
import type { FocusStartArgs } from "@/hooks/use-next-action";
import type { ScheduleSlot } from "@/types";

export type ActiveSitting = { slot: ScheduleSlot; startArgs: FocusStartArgs } | null;

/**
 * The focus timer's one primary button — Start / Pause / Resume — shared by the dashboard timer and
 * the floating widget so the two can never disagree about what pressing it does.
 *
 * Idle on a focus countdown that is still following the active block (nothing picked by hand), Start
 * *is* the Now card's "Start focus": the same block, the same what's-left-of-the-sitting length, the
 * same attribution, a reading block through the reading picker. Otherwise it toggles the countdown
 * as it stands — a break, a hand-picked task, or a paused session resuming exactly where it stopped.
 */
export function useTimerPrimary(active: ActiveSitting, startSitting: (slot: ScheduleSlot, args: FocusStartArgs) => void) {
  const focus = useFocusSession();
  const startsSitting = focus.phase === "idle" && focus.mode === "work" && focus.autoFollowing && active !== null;
  // What the idle display should promise: the length Start will actually arm, not the settings default.
  const displaySeconds = startsSitting ? focus.sittingLengthFor(active.startArgs.minutes) * 60 : focus.secondsLeft;
  /** The full length of that countdown, in minutes. */
  const displayLengthMinutes = startsSitting ? focus.sittingLengthFor(active.startArgs.minutes) : focus.duration;

  const label =
    focus.phase === "running"
      ? "Pause"
      : focus.phase === "paused"
        ? "Resume"
        : focus.mode === "work"
          ? "Start"
          : "Start break";

  function run() {
    if (startsSitting) startSitting(active.slot, active.startArgs);
    else focus.toggleRunning();
  }

  return { label, run, displaySeconds, displayLengthMinutes, startsSitting };
}
