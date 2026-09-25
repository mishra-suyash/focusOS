#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/next-action.ts's `pickNextAction` (plan/14 §7.1, §12 AC #8/#9) — same
 * pattern as scripts/verify-timeline.ts, since this repo has no test runner. Focused on the new
 * schedule-first first branch; the pre-existing cascade below it is exercised only enough to prove
 * it still runs unchanged when there's no active/imminent block.
 */
import { pickNextAction } from "../lib/next-action";
import type { ScheduleSlot } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

const TODAY = "2026-09-24";
const WEEK_END = "2026-09-27";

function slot(partial: Partial<ScheduleSlot> & Pick<ScheduleSlot, "id" | "type" | "startTime" | "endTime">): ScheduleSlot {
  return { title: "Block", status: "upcoming", ...partial };
}

const base = { checkpoints: [], dueRevisionCount: 0, tasks: [], loadIndexValue: 0, todayKey: TODAY, weekEndKey: WEEK_END };

{
  const active = slot({ id: "a1", type: "deep_work", title: "CS201 revision", startTime: "09:00", endTime: "09:50" });
  const action = pickNextAction({ ...base, activeSlot: active, minute: 570 }); // 09:30
  check("an active block wins over everything else", action?.kind === "block" && action.slot?.id === "a1");
}

{
  const active = slot({ id: "c1", type: "class", title: "CS201 lecture", startTime: "09:00", endTime: "09:50" });
  const action = pickNextAction({ ...base, activeSlot: active, minute: 570 });
  check("an active class block still returns kind 'block' (the card decides Log-this-class vs Start-focus)", action?.kind === "block" && action.why === "In progress");
}

{
  const next = slot({ id: "n1", type: "deep_work", title: "Upcoming block", startTime: "09:40", endTime: "10:30" });
  const action = pickNextAction({ ...base, nextSlot: next, minute: 570 }); // 09:30, block starts 09:40 — 10 min out
  check("a block starting within 15 minutes is offered, marked upcoming", action?.kind === "block" && action.upcoming === true);
  check("its `why` names the minutes until start", action?.why === "Starts in 10 minutes");
}

{
  const next = slot({ id: "n2", type: "deep_work", title: "Later block", startTime: "10:30", endTime: "11:20" });
  const action = pickNextAction({ ...base, nextSlot: next, minute: 570, dueRevisionCount: 3 }); // 60 min out — falls through
  check("a block more than 15 minutes out falls through to the existing cascade", action?.kind === "revision");
}

{
  // No active/next slot at all (dailySchedulesLoading, or no plan today) — the cascade runs exactly
  // as it did before this branch existed.
  const action = pickNextAction({ ...base, dueRevisionCount: 2 });
  check("with no schedule info at all, the pre-existing cascade still runs", action?.kind === "revision");
}

{
  const action = pickNextAction({ ...base });
  check("nothing active, nothing due, nothing urgent: null (unchanged behavior)", action === null);
}

if (failures.length > 0) {
  console.error(`verify-next-action: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-next-action: all lib/next-action.ts checks passed.");
