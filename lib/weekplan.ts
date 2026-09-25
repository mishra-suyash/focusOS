import { getDay, parseISO } from "date-fns";
import { minutesFromTime } from "@/lib/schedule";
import type { ScheduleSlot, UserSettings } from "@/types";

export type WorkingWindow = NonNullable<UserSettings["workingWindow"]>;

/** Mon–Sat, 09:00–18:00 — the default when `UserSettings.workingWindow` is unset (plan/14 §5.3). */
export const DEFAULT_WORKING_WINDOW: WorkingWindow = {
  startTime: "09:00",
  endTime: "18:00",
  daysOfWeek: [1, 2, 3, 4, 5, 6]
};

/**
 * plan/14 §5.6 — the fixed weekly-planning admin block, mirroring `routineSlotsForDate`/
 * `courseSlotsForDate` in shape: pure, no Firestore. Returns a locked slot with the stable id
 * `weekly-planning` when `dateKey`'s day-of-week matches the setting, else `null`. The stable id
 * lets `mergeMissingLockedSlots` treat it exactly like a routine block at each of its three call
 * sites (Start day, `/plan/day`, `/plan/calendar`).
 */
export function weeklyPlanningSlotForDate(setting: UserSettings["weeklyPlanning"], dateKey: string): ScheduleSlot | null {
  if (!setting?.enabled) return null;
  if (getDay(parseISO(dateKey)) !== setting.dayOfWeek) return null;
  return {
    id: "weekly-planning",
    title: "Weekly planning",
    type: "admin",
    startTime: setting.startTime,
    endTime: setting.endTime,
    status: "upcoming",
    locked: true
  };
}

/**
 * Minutes of `windowStart`–`windowEnd` (minute-of-day) covered by `slots`, clamping each slot to
 * the window and merging overlaps before summing — a slot that starts before the window or ends
 * after it only contributes the part that actually falls inside. A block wholly outside the window
 * (a 23:00 sleep block, an 08:00 commute against a 09:00–18:00 window) clamps to an empty interval
 * and contributes nothing, which is the property plan/14 AC #5 checks.
 */
function coveredMinutesInWindow(windowStart: number, windowEnd: number, slots: Pick<ScheduleSlot, "startTime" | "endTime">[]): number {
  const intervals = slots
    .map((slot): [number, number] => [Math.max(windowStart, minutesFromTime(slot.startTime)), Math.min(windowEnd, minutesFromTime(slot.endTime))])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [start, end] of intervals) {
    if (curEnd === -1) {
      curStart = start;
      curEnd = end;
    } else if (start <= curEnd) {
      curEnd = Math.max(curEnd, end);
    } else {
      covered += curEnd - curStart;
      curStart = start;
      curEnd = end;
    }
  }
  if (curEnd !== -1) covered += curEnd - curStart;
  return covered;
}

/**
 * plan/14 §5.3 — the capacity meter's `free`, deliberately not "the week minus what's booked" (that
 * formula counts 03:00 on a Tuesday as available and yields a number that tells the user they have
 * room to spare — the opposite of what this step exists to produce). `free` is the hours the user
 * intends to work, minus what those hours already contain: for each date in `weekDateKeys` whose
 * day-of-week is in `workingWindow.daysOfWeek`, the working window's length minus whatever of
 * `claimedSlotsByDate[dateKey]` (classes, routine blocks, recurring commitments, already-saved
 * schedule, Google Calendar imports — plan/14 §5.2's "week already contains" layers) falls inside
 * it. `committedMinutes` is passed through unchanged — it's the sum of what Step 3's bucket targets
 * plus checkpoint prep plus the revision queue ask for, which this function has no way to compute
 * on its own (targets are a Step-3 input, not a schedule fact).
 */
export function weekCapacity(params: {
  workingWindow: WorkingWindow;
  weekDateKeys: string[];
  claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]>;
  committedMinutes: number;
}): { freeMinutes: number; committedMinutes: number } {
  const { workingWindow, weekDateKeys, claimedSlotsByDate, committedMinutes } = params;
  const windowStart = minutesFromTime(workingWindow.startTime);
  const windowEnd = minutesFromTime(workingWindow.endTime);
  const windowLength = Math.max(0, windowEnd - windowStart);

  const freeMinutes = weekDateKeys.reduce((sum, dateKey) => {
    if (!workingWindow.daysOfWeek.includes(getDay(parseISO(dateKey)))) return sum;
    const covered = coveredMinutesInWindow(windowStart, windowEnd, claimedSlotsByDate[dateKey] ?? []);
    return sum + Math.max(0, windowLength - covered);
  }, 0);

  return { freeMinutes, committedMinutes };
}

/**
 * plan/14 §5.4 — places a proposed block's `durationMinutes` inside `windowStart`–`windowEnd`
 * (minute-of-day) on a date whose existing + already-accepted `slots` are given, earliest fitting
 * gap first. Bounded to the same working-window bounds the capacity meter measures against, so the
 * meter can never promise room the planner then can't place a block in (plan/14 §5.4). Returns
 * `null` — never a partial or out-of-window placement — when nothing fits, so the caller can list
 * the proposal under "Didn't fit" instead of silently dropping it.
 */
export function placeInWindow(
  slots: Pick<ScheduleSlot, "startTime" | "endTime">[],
  windowStart: number,
  windowEnd: number,
  durationMinutes: number,
  stepMinutes = 15
): number | null {
  if (durationMinutes > windowEnd - windowStart) return null;
  // Deliberately not `rangeOverlapsSlots` (lib/timeline.ts) — that function's `excludeId` check
  // compares `slot.id !== excludeId`, which silently treats every slot as "excluded" (so no
  // overlap is ever detected) when both are `undefined`, exactly the shape a synthetic candidate
  // slot built for this placement search has. A plain range check has no such foot-gun.
  const overlaps = (start: number, end: number) =>
    slots.some((slot) => start < minutesFromTime(slot.endTime) && minutesFromTime(slot.startTime) < end);
  for (let start = windowStart; start + durationMinutes <= windowEnd; start += stepMinutes) {
    if (!overlaps(start, start + durationMinutes)) return start;
  }
  return null;
}
