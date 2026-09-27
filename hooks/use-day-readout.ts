"use client";

import { orderBy } from "firebase/firestore";
import { useMemo } from "react";
import { useDay } from "@/hooks/use-day";
import { useLiveLoadIndex } from "@/hooks/use-live-load-index";
import { useUserCollection } from "@/hooks/use-user-collection";
import { computeDayReadout, type DayReadout } from "@/lib/gamify";
import { currentMinute } from "@/lib/schedule";
import type { DailySchedule, PomodoroSession } from "@/types";

/**
 * plan/16 §5.6 — today's score (or pace), computed once and shared.
 *
 * Exactly the reason `useLiveLoadIndex` exists next door: the dashboard line and the floating
 * widget's card both claim to show "today's score", and a second implementation is how two surfaces
 * showing the same day end up disagreeing about it. Acceptance criterion #22 is precisely that they
 * don't, so there is one hook and both call it.
 *
 * `Day.game`, when the day has been closed by End day or the evening rollup, wins over a live
 * recomputation — a historical record must not change under later edits, the same rule
 * `Day.loadIndex` already follows. Everything else is derived from data already subscribed to.
 */
export function useDayReadout(dateKey: string, options: { isToday?: boolean } = {}): DayReadout {
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const { items: dailySchedules } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { day } = useDay(dateKey);
  const loadIndex = useLiveLoadIndex(dateKey);

  const slots = dailySchedules.find((item) => item.dateKey === dateKey)?.slots ?? [];
  // A recurring class or routine slot reuses the same id on every date it materializes on, so
  // coverage has to be measured against that date's own sessions — an unfiltered list would let a
  // session logged against last Thursday's identical slot id count toward this one.
  const daySessions = sessions.filter((session) => session.completedAt.startsWith(dateKey));

  return computeDayReadout({
    slots,
    sessions: daySessions,
    loadIndex,
    isDayOff: Boolean(day?.dayOff),
    nowMinute: (options.isToday ?? true) ? currentMinute() : undefined,
    snapshot: day?.game
  });
}
