#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/routine.ts (plan/07.FocusOS-v2-Routine-Blocks-and-AI-Templates.md §2) —
 * same pattern as scripts/verify-timeline.ts, since this repo has no test runner.
 */
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "../lib/routine";
import type { RoutineBlock } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

function block(partial: Partial<RoutineBlock> & Pick<RoutineBlock, "id" | "startTime" | "endTime">): RoutineBlock {
  return { label: partial.id, type: "custom", enabled: true, ...partial };
}

// A Wednesday and a Sunday, so daysOfWeek filtering has something to bite on.
const WEDNESDAY = "2026-09-16";
const SUNDAY = "2026-09-13";

{
  const slots = routineSlotsForDate([block({ id: "lunch", startTime: "12:30", endTime: "13:15" })], WEDNESDAY);
  check("same-day block materializes as one locked slot", slots.length === 1 && slots[0].locked === true);
  check("same-day block keeps its own times", slots[0]?.startTime === "12:30" && slots[0]?.endTime === "13:15");
}

{
  const slots = routineSlotsForDate([block({ id: "gym", startTime: "17:00", endTime: "18:00", enabled: false })], WEDNESDAY);
  check("a disabled block materializes nothing", slots.length === 0);
}

{
  const slots = routineSlotsForDate([block({ id: "gym", startTime: "17:00", endTime: "18:00", daysOfWeek: [1, 2, 3, 4, 5] })], SUNDAY);
  check("daysOfWeek excludes a non-matching day", slots.length === 0);
}

{
  const slots = routineSlotsForDate([block({ id: "gym", startTime: "17:00", endTime: "18:00", daysOfWeek: [1, 2, 3, 4, 5] })], WEDNESDAY);
  check("daysOfWeek includes a matching day", slots.length === 1);
}

{
  const slots = routineSlotsForDate([block({ id: "sleep", startTime: "23:00", endTime: "07:00" })], WEDNESDAY);
  check("overnight block splits into exactly two same-day slots", slots.length === 2);
  const wake = slots.find((s) => s.id === "routine-sleep-wake");
  const bed = slots.find((s) => s.id === "routine-sleep-bed");
  check("overnight wake segment runs 00:00 to the configured end", wake?.startTime === "00:00" && wake?.endTime === "07:00");
  check("overnight bed segment runs the configured start to 24:00", bed?.startTime === "23:00" && bed?.endTime === "24:00");
  check("both overnight segments are locked", wake?.locked === true && bed?.locked === true);
}

{
  // Identical start/end is a data-entry mistake, not "crosses midnight" — must not black out the day.
  const slots = routineSlotsForDate([block({ id: "oops", startTime: "09:00", endTime: "09:00" })], WEDNESDAY);
  check("a zero-duration block materializes nothing (never a near-24h blackout)", slots.length === 0);
}

{
  // First-listed wins on overlap, matching lib/timeline.ts's fillGaps policy.
  const slots = routineSlotsForDate(
    [block({ id: "first", startTime: "08:00", endTime: "09:00" }), block({ id: "second", startTime: "08:30", endTime: "09:30" })],
    WEDNESDAY
  );
  check("two overlapping enabled blocks: only the first-listed survives", slots.length === 1 && slots[0].id === "routine-first");
}

{
  const slots = routineSlotsForDate(DEFAULT_ROUTINE_BLOCKS, WEDNESDAY);
  check("DEFAULT_ROUTINE_BLOCKS: Gym is off by default", !slots.some((s) => s.id === "routine-gym"));
  check(
    "DEFAULT_ROUTINE_BLOCKS: sleep/breakfast/lunch/dinner are on by default",
    slots.some((s) => s.id === "routine-sleep-wake") &&
      slots.some((s) => s.id === "routine-sleep-bed") &&
      slots.some((s) => s.id === "routine-breakfast") &&
      slots.some((s) => s.id === "routine-lunch") &&
      slots.some((s) => s.id === "routine-dinner")
  );
}

if (failures.length > 0) {
  console.error(`verify-routine: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-routine: all lib/routine.ts checks passed.");
