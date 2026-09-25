"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { saveDailySchedule, subscribeDoc } from "@/lib/firestore";
import { currentMinute, isLockedSlot, minutesFromTime, sortedSlots } from "@/lib/schedule";
import type { DailySchedule, ScheduleSlot } from "@/types";

/**
 * plan/14 §6.5 — the honest half of block auto-completion. `slotAutoStatus` (lib/tracking.ts,
 * run from `FocusSessionProvider` and `WorkdaySessionProvider.end()`) already flips a block to
 * `completed` when logged sessions or class attendance cover it. What it deliberately never does
 * is mark a block completed just because its end time passed (plan/13 A9 — that read a day where
 * nothing happened as "100% complete"). So a block whose time passed without enough coverage stays
 * `past` forever unless something asks. This is that ask: one row per uncovered past block,
 * Done/Skipped, one tap each.
 *
 * Locked slots (`isLockedSlot`) are excluded — class blocks are asked about through the class-log
 * flow instead (S3), and routine/external blocks aren't something the user "did or skipped."
 *
 * Shared by both wrap-up surfaces (`/reviews/daily` and `DayWrapupSheet`) so a user routed to
 * either one still gets asked, rather than only whichever page happened to build this first.
 * Renders nothing for a date with no schedule, or once nothing is left uncovered.
 */
export function UncoveredBlocksReview({
  date,
  embedded
}: {
  date: string;
  /** True inside `DayWrapupSheet`, which already provides its own card chrome around a fixed-width
   *  modal — the standalone `card mt-6 max-w-3xl` wrapper used on `/reviews/daily` would nest a
   *  wider card inside a narrower one there, so `embedded` renders just the heading and rows. */
  embedded?: boolean;
}) {
  const { user } = useAuth();
  const [schedule, setSchedule] = useState<DailySchedule | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setSchedule(null);
      return;
    }
    return subscribeDoc<DailySchedule>(user.uid, "dailySchedules", date, setSchedule);
  }, [user, date]);

  if (!schedule) return null;

  const minute = currentMinute();
  const uncovered = sortedSlots(schedule.slots).filter(
    (slot) => slot.status !== "completed" && slot.status !== "skipped" && !isLockedSlot(slot) && minutesFromTime(slot.endTime) <= minute
  );

  if (uncovered.length === 0) return null;

  async function setStatus(slotId: string, status: ScheduleSlot["status"]) {
    if (!user || !schedule) return;
    setSaving(slotId);
    try {
      const slots = schedule.slots.map((slot) => (slot.id === slotId ? { ...slot, status } : slot));
      await saveDailySchedule(user.uid, { dateKey: schedule.dateKey, templateId: schedule.templateId, slots });
    } finally {
      setSaving(null);
    }
  }

  const body = (
    <>
      <p className="label mb-1">Blocks that timed out</p>
      <p className="mb-3 text-xs text-ink-500 dark:text-ink-400">
        Their time passed without enough logged work to mark them done automatically. Done or skipped?
      </p>
      <div className="space-y-2">
        {uncovered.map((slot) => (
          <div key={slot.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-50 px-3 py-2 text-sm dark:bg-ink-800">
            <span>
              {slot.title} <span className="text-xs text-ink-500 dark:text-ink-400">{slot.startTime}–{slot.endTime}</span>
            </span>
            <div className="flex gap-2">
              <button
                className="btn-secondary py-1 text-xs"
                disabled={saving === slot.id}
                onClick={() => setStatus(slot.id, "completed")}
              >
                Done
              </button>
              <button
                className="btn-secondary py-1 text-xs"
                disabled={saving === slot.id}
                onClick={() => setStatus(slot.id, "skipped")}
              >
                Skipped
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );

  return embedded ? <div className="mb-4">{body}</div> : <section className="card mt-6 max-w-3xl p-5">{body}</section>;
}
