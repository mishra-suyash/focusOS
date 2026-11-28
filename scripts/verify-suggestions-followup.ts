#!/usr/bin/env tsx
/**
 * Pure-function checks for plan/20 (the owner's suggestions follow-up, 2026-11-28): Workload's
 * required minutes counting every planned sitting with the targets netted, rescheduled originals
 * leaving the score, a paper's goal link in goal pace, and the pass-output minimum. Same pattern as
 * scripts/verify-chunking.ts: no Firestore, no rendering, no user flow.
 */
import { computeDayScore } from "../lib/gamify";
import { goalWeekPace } from "../lib/goals";
import { buildLoadIndexSnapshot, computeRequiredMinutes } from "../lib/loadindex";
import { plannedWorkOf } from "../lib/planned-work";
import { passOutputShortfall } from "../lib/papers";
import { accountedSlotMinutes } from "../lib/courses";
import { MINUTES_PER_REVISION } from "../lib/revision";
import type { Course, Goal, Pass1Output, Pass2Output, PomodoroSession, ScheduleSlot } from "../types";

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

let n = 0;
const slot = (over: Partial<ScheduleSlot>): ScheduleSlot => ({ id: `s${++n}`, title: "Sitting", type: "reading", startTime: "06:00", endTime: "06:45", status: "upcoming", ...over });
const saturday = "2026-11-28";
const allDays = [0, 1, 2, 3, 4, 5, 6];
const litGoal = { id: "lit", title: "Literature", status: "active", horizon: "year", targetHoursPerWeek: 7, milestones: [], linked: { courseIds: [], paperIds: [], taskIds: [], goalIds: [] } } as unknown as Goal;

// --- 1.6: a planned reading day isn't "Overrun" ---
{
  // Eight 45-minute reading sittings (360 min), 307 minutes of focus by the evening.
  const slots = Array.from({ length: 8 }, (_, i) => slot({ startTime: `${String(6 + i).padStart(2, "0")}:00`, endTime: `${String(6 + i).padStart(2, "0")}:45` }));
  const planned = plannedWorkOf(slots);
  check("every reading sitting is planned work", planned.minutes === 360, String(planned.minutes));
  const snapshot = buildLoadIndexSnapshot({ planned, revisionDueCount: 0, revisionsCompletedCount: 0, checkpoints: [], courses: [], goals: [litGoal], terms: [], focusedMinutes: 307, todayKey: saturday, workingDaysOfWeek: allDays });
  check("the reading day reads light/on track, not overrun", snapshot.band !== "overrun" && snapshot.band !== "ahead", `${snapshot.band} ${snapshot.value} (required ${snapshot.requiredMinutes})`);
  // The goal's 60 min/day share comes on top, since none of these sittings is linked to it.
  check("an unlinked goal still asks for its share", snapshot.requiredMinutes === 420, String(snapshot.requiredMinutes));

  // Linking the papers to the goal (1.7) nets the share against the sittings: no double count.
  const linked = slots.map((s) => ({ ...s, objectiveRef: { kind: "paper" as const, id: "lithos", passNo: 2 as const } }));
  const nettedPlan = plannedWorkOf(linked, [{ id: "lithos", goalId: "lit" }]);
  check("paper sittings count toward their linked goal", nettedPlan.byGoal.lit === 360, JSON.stringify(nettedPlan.byGoal));
  const netted = computeRequiredMinutes({ planned: nettedPlan, revisionDueCount: 0, revisionsCompletedCount: 0, checkpoints: [], courses: [], goals: [litGoal], terms: [], focusedMinutes: 0, todayKey: saturday, workingDaysOfWeek: allDays });
  check("a goal covered by its sittings asks nothing more", netted === 360, String(netted));
}

// --- the netting: each target asks only for what the blocks don't cover ---
{
  const course = { id: "c", status: "active", targetMinutesPerWeek: 420 } as unknown as Course;
  const base = { revisionDueCount: 3, revisionsCompletedCount: 0, checkpoints: [], courses: [course], goals: [litGoal], terms: [], focusedMinutes: 0, todayKey: saturday, workingDaysOfWeek: allDays };
  const empty = computeRequiredMinutes({ ...base, planned: plannedWorkOf([]) });
  check("an empty day asks for its targets", empty === 3 * MINUTES_PER_REVISION + 60 + 60, String(empty));
  const goalBlock = slot({ type: "deep_work", startTime: "09:00", endTime: "09:50", objectiveRef: { kind: "goal", id: "lit" } });
  const revisionBlock = slot({ type: "deep_work", startTime: "10:00", endTime: "10:30", courseId: "c", bucket: "revision" });
  const withBlocks = computeRequiredMinutes({ ...base, planned: plannedWorkOf([goalBlock, revisionBlock]) });
  check("goal and course sittings net their shares", withBlocks === 50 + 30 + 3 * MINUTES_PER_REVISION + (60 - 50) + (60 - 30), String(withBlocks));
  const queue = slot({ type: "deep_work", startTime: "11:00", endTime: "11:30", objectiveRef: { kind: "revisionQueue" } });
  const withQueue = computeRequiredMinutes({ ...base, planned: plannedWorkOf([queue]) });
  check("a revision-queue sitting nets the revision due", withQueue === 30 + Math.max(0, 3 * MINUTES_PER_REVISION - 30) + 60 + 60, String(withQueue));
}

// --- 1.5: skipped and rescheduled blocks ---
{
  const missed = slot({ startTime: "05:30", endTime: "06:25", status: "skipped", rescheduledTo: { dateKey: saturday, slotId: "copy" } });
  const copy = slot({ id: "copy", startTime: "09:00", endTime: "09:55" });
  const plain = slot({ startTime: "07:00", endTime: "07:45", status: "skipped" });
  const tentative = slot({ type: "admin", startTime: "15:00", endTime: "15:45", tentative: true });
  const anchor = slot({ id: "weekly-planning", type: "admin", startTime: "18:00", endTime: "18:30", locked: true });
  const planned = plannedWorkOf([missed, copy, plain, tentative, anchor]);
  check("only the copy is planned work (not the moved original, a skip, a tentative hold or the locked planning anchor)", planned.minutes === 55, String(planned.minutes));
  const skippedAll = computeRequiredMinutes({ planned: plannedWorkOf([plain]), revisionDueCount: 0, revisionsCompletedCount: 0, checkpoints: [], courses: [], goals: [litGoal], terms: [], focusedMinutes: 0, todayKey: saturday, workingDaysOfWeek: allDays });
  check("skipping everything leaves the standing targets", skippedAll === 60, String(skippedAll));
  const score = computeDayScore({ slots: [missed, copy, plain], sessions: [{ slotId: "copy", mode: "work", minutes: 55 }] });
  check("the day score leaves out the rescheduled original", score.sittingsPlanned === 2, String(score.sittingsPlanned));
  check("but still counts a plain skip", score.minutesPlanned === 55 + 45, String(score.minutesPlanned));
  check("the planner counts a rescheduled original only through its sessions", accountedSlotMinutes(missed, saturday) === 0);
}

// --- 1.7: goal pace counts linked-paper time ---
{
  const week = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"];
  const reading = slot({ id: "r1", startTime: "06:00", endTime: "06:45", objectiveRef: { kind: "paper", id: "lithos" } });
  const sessions = [
    { slotId: "r1", slotDateKey: "2026-11-27", completedAt: "2026-11-27T06:45:00Z", mode: "work", minutes: 45, paperId: "lithos" },
    // A habit sitting that picked Janus at start: no paper objective on its block, the session carries it.
    { slotId: "h1", slotDateKey: "2026-11-27", completedAt: "2026-11-27T08:00:00Z", mode: "work", minutes: 30, paperId: "janus" }
  ] as Pick<PomodoroSession, "slotId" | "slotDateKey" | "completedAt" | "mode" | "minutes" | "courseId" | "bucket" | "paperId">[];
  const params = { goals: [litGoal], schedules: [{ dateKey: "2026-11-27", slots: [reading] }], sessions, weekDateKeys: week, todayKey: saturday, nowMinutes: 17 * 60 };
  const unlinked = goalWeekPace(params)[0];
  check("without a link, paper reading isn't goal time", unlinked.loggedMinutes === 0 && Boolean(unlinked.warning));
  const linked = goalWeekPace({ ...params, papers: [{ id: "lithos", goalId: "lit" }, { id: "janus", goalId: "lit" }] })[0];
  check("linked-paper sessions count once each", linked.loggedMinutes === 75, String(linked.loggedMinutes));
}

// --- 1.4: what the pass forms require ---
{
  check("a Skim kept going with no contribution falls short", passOutputShortfall(1, { contributions: [], verdict: "continue" } as unknown as Pass1Output) !== null);
  check("a dropped Skim needs none", passOutputShortfall(1, { contributions: [], verdict: "drop" } as unknown as Pass1Output) === null);
  check("a grasped Read with 1 key point falls short", passOutputShortfall(2, { keyPoints: ["x"], outcome: "grasped" } as unknown as Pass2Output) !== null);
  check("a Read set aside needs none", passOutputShortfall(2, { keyPoints: [], outcome: "set-aside" } as unknown as Pass2Output) === null);
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("✓ verify-suggestions-followup: all checks passed");
