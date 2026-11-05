import { fetchCollection, saveDailySchedule } from "@/lib/firestore";
import { resyncRoutineOnDay, routineSlotsForDate } from "@/lib/routine";
import { minutesFromTime, sortedSlots } from "@/lib/schedule";
import { rangeOverlapsSlots } from "@/lib/timeline";
import { weeklyPlanningSlotForDate, type ReleaseClock, type ReleasedSlot } from "@/lib/weekplan";
import type { DailySchedule, RoutineBlock, ScheduleSlot, UserSettings } from "@/types";

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

export interface RoutineDayChange {
  dateKey: string;
  templateId?: string;
  before: ScheduleSlot[];
  after: ScheduleSlot[];
  released: number;
  steppedAside: string[];
}

/** Brings today and every later saved day up to the routine. Past days are what happened, so they keep theirs. */
export async function resyncRoutineDays(
  uid: string,
  blocks: RoutineBlock[],
  weeklyPlanning: UserSettings["weeklyPlanning"],
  clock: ReleaseClock
): Promise<RoutineDayChange[]> {
  const schedules = await fetchCollection<DailySchedule>(uid, "dailySchedules");
  const changes: RoutineDayChange[] = [];
  for (const schedule of schedules) {
    if (schedule.dateKey < clock.todayKey) continue;
    const anchor = weeklyPlanningSlotForDate(weeklyPlanning, schedule.dateKey);
    const wanted = [...routineSlotsForDate(blocks, schedule.dateKey), ...(anchor ? [anchor] : [])];
    const result = resyncRoutineOnDay({ dateKey: schedule.dateKey, slots: schedule.slots, wanted, clock });
    if (!result) continue;
    await saveDailySchedule(uid, { dateKey: schedule.dateKey, templateId: schedule.templateId, slots: result.slots });
    changes.push({
      dateKey: schedule.dateKey,
      templateId: schedule.templateId,
      before: schedule.slots,
      after: result.slots,
      released: result.released.length,
      steppedAside: result.steppedAside
    });
  }
  return changes;
}

/** Firestore doesn't keep a map's key order, so two copies of a day are compared by what they say, not by their JSON. */
function slotsSignature(slots: ScheduleSlot[]): string {
  return sortedSlots(slots)
    .map((slot) => [slot.id, slot.startTime, slot.endTime, slot.status, slot.title].join("|"))
    .join("\n");
}

/** Undo: only a day that hasn't changed since goes back, so a later edit is never overwritten. Returns how many didn't. */
export async function undoRoutineDays(uid: string, changes: RoutineDayChange[]): Promise<number> {
  const schedules = await fetchCollection<DailySchedule>(uid, "dailySchedules");
  let skipped = 0;
  for (const change of changes) {
    const current = schedules.find((schedule) => schedule.dateKey === change.dateKey);
    if (!current || slotsSignature(current.slots) !== slotsSignature(change.after)) {
      skipped += 1;
      continue;
    }
    await saveDailySchedule(uid, { dateKey: change.dateKey, templateId: change.templateId, slots: change.before });
  }
  return skipped;
}
