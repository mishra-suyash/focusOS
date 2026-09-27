"use client";

import { InfoHint } from "@/components/info-hint";
import { useDayReadout } from "@/hooks/use-day-readout";
import { formatDayReadout } from "@/lib/gamify";

/**
 * plan/16 §5.6 — the day's one line: sittings closed, minutes logged against minutes planned, and
 * either a pace (while the day is still running) or a score (once it's done), plus the existing
 * on-track streak.
 *
 * Everything here is a readout of numbers the app already measures. There is no currency, no
 * levels, no badges and no loss framing — a low number is information about a day, not a verdict on
 * a person, and "you broke your streak!" is the kind of copy plan/08 was right to ban. The streak
 * shown is `computeLoadIndexStreak`, the one that already exists, not a new one invented to have
 * something to count.
 */
export function DayScoreLine({ dateKey, streak }: { dateKey: string; streak: number }) {
  const readout = useDayReadout(dateKey);
  if (readout.sittingsPlanned === 0) return null;

  return (
    <section className="card flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
      <span className="inline-flex items-center gap-1">
        <span className="label">Today</span>
        <InfoHint term="dayScore" />
      </span>
      <span className="text-ink-600 dark:text-ink-300">{formatDayReadout(readout)}</span>
      <span className="text-xs text-ink-500">on-track streak {streak}d</span>
    </section>
  );
}
