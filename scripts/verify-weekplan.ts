#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/weekplan.ts (plan/14 §5.3/§5.4/§5.6, §12) — same pattern as
 * scripts/verify-tracking.ts, since this repo has no test runner.
 */
import { DEFAULT_WORKING_WINDOW, placeInWindow, weekCapacity, weeklyPlanningSlotForDate } from "../lib/weekplan";
import { minutesFromTime } from "../lib/schedule";
import type { ScheduleSlot } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

// Mon 2026-09-21 .. Sun 2026-09-27
const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];
const MON = WEEK[0];
const TUE = WEEK[1];
const SUN = WEEK[6];

// --- weekCapacity (§5.3, plan/14 AC #5) ---

{
  // Default window: Mon-Sat 09:00-18:00 = 9h x 6 = 3240 min free with nothing claimed. Sunday isn't
  // in daysOfWeek at all, so anything on Sunday (claimed or not) contributes zero either way.
  const { freeMinutes } = weekCapacity({
    workingWindow: DEFAULT_WORKING_WINDOW,
    weekDateKeys: WEEK,
    claimedSlotsByDate: {},
    committedMinutes: 0
  });
  check("empty week: free = 6 working days x 9h", freeMinutes === 6 * 9 * 60, `got ${freeMinutes}`);
}

{
  // AC #5's exact case: a block wholly outside the window (23:00 sleep, 08:00 commute) changes
  // free by nothing.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [MON]: [
      { startTime: "23:00", endTime: "23:59" }, // wholly after the window
      { startTime: "07:30", endTime: "08:00" } // wholly before the window
    ]
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("blocks wholly outside the window don't reduce free", freeMinutes === 6 * 9 * 60, `got ${freeMinutes}`);
}

{
  // A block straddling the window's edge only loses the part actually inside.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [MON]: [{ startTime: "08:30", endTime: "09:30" }] // 30 min inside a 09:00-18:00 window
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("a block straddling the window's edge only loses the overlapping part", freeMinutes === 6 * 9 * 60 - 30, `got ${freeMinutes}`);
}

{
  // Sunday is a non-working day under the default window: fully claiming it changes nothing.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [SUN]: [{ startTime: "00:00", endTime: "23:59" }]
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("a non-working day contributes nothing even fully claimed", freeMinutes === 6 * 9 * 60, `got ${freeMinutes}`);
}

{
  // Overlapping claimed slots inside the window don't double-subtract.
  const claimedSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]> = {
    [MON]: [
      { startTime: "10:00", endTime: "11:00" },
      { startTime: "10:30", endTime: "11:30" }
    ]
  };
  const { freeMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate, committedMinutes: 0 });
  check("overlapping claimed intervals merge instead of double-subtracting", freeMinutes === 6 * 9 * 60 - 90, `got ${freeMinutes}`);
}

{
  const { committedMinutes } = weekCapacity({ workingWindow: DEFAULT_WORKING_WINDOW, weekDateKeys: WEEK, claimedSlotsByDate: {}, committedMinutes: 425 });
  check("committedMinutes passes through unchanged", committedMinutes === 425);
}

// --- placeInWindow (§5.4) ---

{
  const start = placeInWindow([], minutesFromTime("09:00"), minutesFromTime("18:00"), 50);
  check("an empty day places at the window's start", start === minutesFromTime("09:00"), `got ${start}`);
}

{
  // Existing slot ends at a 15-min-aligned boundary so the stepped search lands on it exactly.
  const existing: ScheduleSlot[] = [{ id: "a", title: "A", type: "deep_work", startTime: "09:00", endTime: "09:45", status: "upcoming" }];
  const start = placeInWindow(existing, minutesFromTime("09:00"), minutesFromTime("18:00"), 50);
  check("skips a taken gap for the next one", start === minutesFromTime("09:45"), `got ${start}`);
}

{
  // A candidate that would only fit by spilling past the window end is refused, not clamped.
  const existing: ScheduleSlot[] = [{ id: "a", title: "A", type: "deep_work", startTime: "09:00", endTime: "17:40", status: "upcoming" }];
  const start = placeInWindow(existing, minutesFromTime("09:00"), minutesFromTime("18:00"), 50);
  check("refuses a placement that would spill past the window end", start === null, `got ${start}`);
}

{
  // A duration longer than the window itself never fits.
  const start = placeInWindow([], minutesFromTime("09:00"), minutesFromTime("18:00"), 999);
  check("a duration longer than the window is refused", start === null, `got ${start}`);
}

// --- weeklyPlanningSlotForDate (§5.6) ---

{
  const slot = weeklyPlanningSlotForDate({ enabled: true, dayOfWeek: 0, startTime: "18:00", endTime: "18:30" }, SUN); // Sunday
  check("matching day-of-week returns a locked admin slot", slot !== null && slot.locked === true && slot.type === "admin" && slot.id === "weekly-planning");
}

{
  const slot = weeklyPlanningSlotForDate({ enabled: true, dayOfWeek: 0, startTime: "18:00", endTime: "18:30" }, MON); // Monday, wrong day
  check("a non-matching day-of-week returns null", slot === null);
}

{
  const slot = weeklyPlanningSlotForDate({ enabled: false, dayOfWeek: 0, startTime: "18:00", endTime: "18:30" }, SUN);
  check("disabled returns null even on the matching day", slot === null);
}

{
  const slot = weeklyPlanningSlotForDate(undefined, SUN);
  check("an absent setting returns null (the feature is off by default)", slot === null);
}

if (failures.length > 0) {
  console.error(`verify-weekplan: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-weekplan: all lib/weekplan.ts checks passed.");
