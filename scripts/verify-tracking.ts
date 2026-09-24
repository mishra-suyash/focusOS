#!/usr/bin/env tsx
/**
 * Unit-test stand-in for lib/tracking.ts and lib/courses.ts's `completedMinutesThisWeek` (plan/14
 * §6.3/§6.4/§6.5, §12) — same pattern as scripts/verify-timeline.ts, since this repo has no test
 * runner.
 */
import { completedMinutesThisWeek } from "../lib/courses";
import { classMinutesForWeek, slotAutoStatus, slotCoverageMinutes } from "../lib/tracking";
import type { ClassLog, PomodoroSession, ScheduleSlot, Task } from "../types";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures.push(detail ? `${label}: ${detail}` : label);
}

const MON = "2026-09-21";
const TUE = "2026-09-22";
const WED = "2026-09-23";
const WEEK = [MON, TUE, WED, "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

function slot(partial: Partial<ScheduleSlot> & Pick<ScheduleSlot, "id" | "type" | "startTime" | "endTime">): ScheduleSlot {
  return { title: "Block", status: "upcoming", ...partial };
}

function session(partial: Partial<PomodoroSession> & Pick<PomodoroSession, "minutes" | "completedAt">): PomodoroSession {
  return { id: "s1", label: "Focus", category: "research", mode: "work", cycle: 1, ...partial };
}

// --- slotCoverageMinutes / slotAutoStatus (§6.5) ---

{
  const block = slot({ id: "b1", type: "deep_work", startTime: "09:00", endTime: "09:50" }); // 50 min
  const sessions = [session({ minutes: 35, completedAt: `${MON}T09:10:00.000Z`, slotId: "b1" })];
  check("slotCoverageMinutes sums sessions tied to this slot", slotCoverageMinutes(block, sessions) === 35);
  check("35/50 = 70%, at/above the 60% default threshold: auto-completes", slotAutoStatus(block, sessions) === "completed");
}

{
  const block = slot({ id: "b1", type: "deep_work", startTime: "09:00", endTime: "09:50" });
  const sessions = [session({ minutes: 10, completedAt: `${MON}T09:10:00.000Z`, slotId: "b1" })];
  check("10/50 = 20%, below threshold: stays past (null), never forced complete by the clock", slotAutoStatus(block, sessions) === null);
}

{
  const block = slot({ id: "b1", type: "deep_work", startTime: "09:00", endTime: "09:50" });
  const sessions = [session({ minutes: 40, completedAt: `${MON}T09:10:00.000Z`, slotId: "b2" })]; // wrong slot
  check("sessions tied to a different slot don't count", slotCoverageMinutes(block, sessions) === 0);
}

{
  const block = slot({ id: "b1", type: "deep_work", startTime: "09:00", endTime: "09:20" }); // 20 min
  const sessions = [session({ minutes: 60, completedAt: `${MON}T09:10:00.000Z`, slotId: "b1" })]; // way over
  check("coverage clamps to the block's own duration, never exceeds it", slotCoverageMinutes(block, sessions) === 20);
}

{
  const block = slot({ id: "b1", type: "deep_work", startTime: "09:00", endTime: "09:50" });
  const sessions = [session({ minutes: 30, completedAt: `${MON}T09:10:00.000Z`, slotId: "b1", mode: "short_break" })];
  check("a break-mode session against the slot doesn't count toward coverage", slotCoverageMinutes(block, sessions) === 0);
}

{
  const block = slot({ id: "b1", type: "deep_work", startTime: "09:00", endTime: "09:50" });
  const sessions = [session({ minutes: 30, completedAt: `${MON}T09:10:00.000Z`, slotId: "b1" })]; // 30/50 = 60%, exactly at threshold
  check("exactly at the threshold counts as completed (>=, not >)", slotAutoStatus(block, sessions) === "completed");
}

{
  const block = slot({ id: "c1", type: "class", startTime: "10:00", endTime: "11:00" });
  check("a class block never auto-completes from session coverage alone", slotAutoStatus(block, [{ mode: "work", minutes: 200, slotId: "c1" }]) === null);
  check("a class block completes once attendance says so", slotAutoStatus(block, [], true) === "completed");
  check("a class block stays past with no attendance recorded", slotAutoStatus(block, [], false) === null);
}

// --- classMinutesForWeek (§6.3) ---

{
  const slotsByDate = { [MON]: [{ startTime: "10:00", endTime: "11:20" }] }; // 80 min
  const logs: Pick<ClassLog, "date" | "attendance" | "durationMin">[] = [{ date: MON, attendance: "attended" }];
  check("attended class with no duration override counts the block's own duration", classMinutesForWeek(slotsByDate, logs, WEEK) === 80);
}

{
  const slotsByDate = { [MON]: [{ startTime: "10:00", endTime: "11:20" }] };
  const logs: Pick<ClassLog, "date" | "attendance" | "durationMin">[] = [{ date: MON, attendance: "attended", durationMin: 55 }];
  check("ClassLog.durationMin overrides the block's own duration (the class ran short)", classMinutesForWeek(slotsByDate, logs, WEEK) === 55);
}

{
  const slotsByDate = { [MON]: [{ startTime: "10:00", endTime: "11:20" }] };
  const logs: Pick<ClassLog, "date" | "attendance" | "durationMin">[] = [{ date: MON, attendance: "missed" }];
  check("a missed class counts zero", classMinutesForWeek(slotsByDate, logs, WEEK) === 0);
}

{
  const slotsByDate = { [MON]: [{ startTime: "10:00", endTime: "11:00" }] };
  const logs: Pick<ClassLog, "date" | "attendance" | "durationMin">[] = [{ date: MON, attendance: "self_study" }];
  check("self_study counts the same as attended", classMinutesForWeek(slotsByDate, logs, WEEK) === 60);
}

{
  const slotsByDate = { [MON]: [{ startTime: "10:00", endTime: "11:00" }] };
  check("a date with no log at all counts zero", classMinutesForWeek(slotsByDate, [], WEEK) === 0);
}

// --- completedMinutesThisWeek (§6.4) — direct and task-resolved attribution paths ---

function task(partial: Partial<Task> & Pick<Task, "id">): Pick<Task, "id" | "courseId" | "bucket" | "dueDate" | "estimatedPomodoros" | "completedPomodoros"> {
  return { courseId: undefined, bucket: undefined, dueDate: undefined, estimatedPomodoros: undefined, completedPomodoros: undefined, ...partial };
}

{
  // The §2.4 regression this whole rewrite exists to fix: a 7-minute session must move the bucket
  // by 7 minutes, not by a whole nominal pomodoro (25).
  const sessions = [session({ minutes: 7, completedAt: `${MON}T09:00:00.000Z`, courseId: "c1", bucket: "revision" })];
  check(
    "a real 7-minute session directly tagged with courseId/bucket counts as 7 minutes, not a nominal pomodoro",
    completedMinutesThisWeek(sessions, [], "c1", "revision", WEEK) === 7
  );
}

{
  // No courseId/bucket on the session itself — resolved through its taskId, the only path Phase 1
  // exercises for the three planned buckets (plan/14 §11's own caveat).
  const tasks = [task({ id: "t1", courseId: "c1", bucket: "assignment" })];
  const sessions = [session({ minutes: 22, completedAt: `${TUE}T09:00:00.000Z`, taskId: "t1" })];
  check("a session with no direct tag resolves courseId/bucket through its linked task", completedMinutesThisWeek(sessions, tasks, "c1", "assignment", WEEK) === 22);
}

{
  const tasks = [task({ id: "t1", courseId: "c2", bucket: "assignment" })]; // different course
  const sessions = [session({ minutes: 22, completedAt: `${TUE}T09:00:00.000Z`, taskId: "t1" })];
  check("a session resolving to a different course/bucket doesn't count", completedMinutesThisWeek(sessions, tasks, "c1", "assignment", WEEK) === 0);
}

{
  const sessions = [session({ minutes: 15, completedAt: `${WED}T09:00:00.000Z`, courseId: "c1", bucket: "revision", mode: "short_break" })];
  check("a break-mode session never counts, even if tagged", completedMinutesThisWeek(sessions, [], "c1", "revision", WEEK) === 0);
}

{
  const sessions = [session({ minutes: 30, completedAt: "2026-09-14T09:00:00.000Z", courseId: "c1", bucket: "revision" })]; // the prior week
  check("a session outside the given week's date keys doesn't count", completedMinutesThisWeek(sessions, [], "c1", "revision", WEEK) === 0);
}

{
  const direct = session({ minutes: 10, completedAt: `${MON}T09:00:00.000Z`, courseId: "c1", bucket: "revision" });
  const taskTagged = session({ minutes: 12, completedAt: `${TUE}T09:00:00.000Z`, courseId: "c1", bucket: "revision" });
  check("multiple matching sessions in the week sum", completedMinutesThisWeek([direct, taskTagged], [], "c1", "revision", WEEK) === 22);
}

if (failures.length > 0) {
  console.error(`verify-tracking: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("verify-tracking: all lib/tracking.ts and completedMinutesThisWeek checks passed.");
