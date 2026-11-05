"use client";

import { useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/toast-host";
import { fetchCollection } from "@/lib/firestore";
import { removeSittings, restoreSittings } from "@/lib/plan-release";
import { currentMinute } from "@/lib/schedule";
import { todayKey } from "@/lib/dates";
import { sittingsOfFinishedWork, type FinishedWork } from "@/lib/weekplan";
import type { DailySchedule, PomodoroSession } from "@/types";

/**
 * Finished or dropped work gives its future sittings back, or they'd sit on the plan reading as missed.
 * Automatic, with an Undo in the toast: asking each time would be one more step on every finished task.
 * Reopening the work later needs nothing from here, because the planner proposes whatever is owed.
 */
export function useReleaseSittings() {
  const { user } = useAuth();
  const toast = useToast();

  return useCallback(
    async (work: FinishedWork, title: string) => {
      if (!user) return;
      const uid = user.uid;
      const [schedules, sessions] = await Promise.all([
        fetchCollection<DailySchedule>(uid, "dailySchedules"),
        fetchCollection<PomodoroSession>(uid, "pomodoroSessions")
      ]);
      const released = sittingsOfFinishedWork({ schedules, work, todayKey: todayKey(), nowMinutes: currentMinute(), sessions });
      if (released.length === 0) return;
      await removeSittings(uid, released);
      toast({
        message: `Removed ${released.length} planned block${released.length === 1 ? "" : "s"} for “${title}”.`,
        ms: 12000,
        action: {
          label: "Undo",
          onClick: () => {
            void restoreSittings(uid, released).then((restored) => {
              if (restored < released.length) toast({ message: `${released.length - restored} couldn't go back: that time is taken now.` });
            });
          }
        }
      });
    },
    [user, toast]
  );
}
