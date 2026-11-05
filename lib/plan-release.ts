import { fetchCollection, saveDailySchedule } from "@/lib/firestore";
import { minutesFromTime, sortedSlots } from "@/lib/schedule";
import { rangeOverlapsSlots } from "@/lib/timeline";
import type { ReleasedSlot } from "@/lib/weekplan";
import type { DailySchedule } from "@/types";

/** Takes released sittings off their days. Every day is re-read first, so a tab holding a stale copy can't overwrite a newer edit. */
export async function removeSittings(uid: string, released: ReleasedSlot[]) {
  const schedules = await fetchCollection<DailySchedule>(uid, "dailySchedules");
  for (const dateKey of new Set(released.map((item) => item.dateKey))) {
    const schedule = schedules.find((item) => item.dateKey === dateKey);
    if (!schedule) continue;
    const gone = new Set(released.filter((item) => item.dateKey === dateKey).map((item) => item.slot.id));
    await saveDailySchedule(uid, { dateKey, templateId: schedule.templateId, slots: schedule.slots.filter((slot) => !gone.has(slot.id)) });
  }
}

/**
 * Undo: puts released sittings back. A slot only returns to a gap that's still free, because the day may
 * have moved on since (a replan, a block added by hand), and an Undo must never overlap or overwrite that.
 * Returns how many came back.
 */
export async function restoreSittings(uid: string, released: ReleasedSlot[]): Promise<number> {
  const schedules = await fetchCollection<DailySchedule>(uid, "dailySchedules");
  let restored = 0;
  for (const dateKey of new Set(released.map((item) => item.dateKey))) {
    const schedule = schedules.find((item) => item.dateKey === dateKey);
    if (!schedule) continue;
    const slots = [...schedule.slots];
    for (const { slot } of released.filter((item) => item.dateKey === dateKey)) {
      if (slots.some((item) => item.id === slot.id)) continue;
      if (rangeOverlapsSlots(minutesFromTime(slot.startTime), minutesFromTime(slot.endTime), slots)) continue;
      slots.push(slot);
      restored += 1;
    }
    await saveDailySchedule(uid, { dateKey, templateId: schedule.templateId, slots: sortedSlots(slots) });
  }
  return restored;
}
