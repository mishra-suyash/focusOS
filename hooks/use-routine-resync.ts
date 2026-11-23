"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/toast-host";
import { scheduleDayKey } from "@/lib/dates";
import { fetchCollection, saveUserSettings } from "@/lib/firestore";
import { resyncRoutineDays, undoDayChanges } from "@/lib/plan-release";
import { currentMinute } from "@/lib/schedule";
import type { PomodoroSession, RoutineBlock, UserSettings } from "@/types";

type Routine = { routineBlocks: RoutineBlock[]; weeklyPlanning: UserSettings["weeklyPlanning"] };

/** Long enough to outlast typing a time: a half-entered value must not release sittings. */
const SETTLE_MS = 2500;

/**
 * Carries routine edits onto saved days. The routine page saves on every change, so this waits for the
 * edits to settle, and flushes on leaving the page rather than losing them.
 */
export function useRoutineResync() {
  const { user } = useAuth();
  const toast = useToast();
  const timer = useRef<number | null>(null);
  const pending = useRef<{ before: Routine; latest: Routine } | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const edit = pending.current;
    pending.current = null;
    if (!edit || !user) return;
    const uid = user.uid;
    const sessions = await fetchCollection<PomodoroSession>(uid, "pomodoroSessions");
    const changes = await resyncRoutineDays(uid, edit.latest.routineBlocks, edit.latest.weeklyPlanning, { todayKey: scheduleDayKey(), nowMinutes: currentMinute(), sessions });
    if (changes.length === 0) return;
    const released = changes.reduce((sum, change) => sum + change.released, 0);
    const steppedAside = changes.flatMap((change) => change.steppedAside);
    toast({
      message: [
        `Routine updated on ${changes.length} saved day${changes.length === 1 ? "" : "s"}.`,
        released > 0 ? `${released} sitting${released === 1 ? "" : "s"} went back to “to place”.` : "",
        steppedAside.length > 0 ? `${steppedAside.length} routine block${steppedAside.length === 1 ? "" : "s"} stepped aside for something you placed.` : ""
      ]
        .filter(Boolean)
        .join(" "),
      ms: 12000,
      action: {
        label: "Undo",
        onClick: () => {
          void saveUserSettings(uid, { routineBlocks: edit.before.routineBlocks, ...(edit.before.weeklyPlanning ? { weeklyPlanning: edit.before.weeklyPlanning } : {}) });
          void undoDayChanges(uid, changes).then((skipped) => {
            if (skipped > 0) toast({ message: `${skipped} day${skipped === 1 ? "" : "s"} changed since, so ${skipped === 1 ? "it" : "they"} stayed as ${skipped === 1 ? "it is" : "they are"}.` });
          });
        }
      }
    });
  }, [user, toast]);

  useEffect(() => () => void flush(), [flush]);

  return useCallback(
    (before: Routine, latest: Routine) => {
      pending.current = { before: pending.current?.before ?? before, latest };
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), SETTLE_MS);
    },
    [flush]
  );
}
