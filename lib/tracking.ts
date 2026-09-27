import { minutesFromTime } from "@/lib/schedule";
import type { ClassLog, PomodoroSession, ScheduleSlot } from "@/types";

/**
 * plan/14 §6.3 — a class block's duration is real course time but not focus time, so it gets its
 * own read-only total rather than folding into `completedMinutesThisWeek`. Sums, for each date in
 * the week whose `ClassLog` records attendance, either that log's own `durationMin` (the override
 * for a class that ran long or short — the one honest use for a field that was otherwise dead) or
 * the duration of that date's class blocks for the course.
 */
export function classMinutesForWeek(
  courseSlotsByDate: Record<string, Pick<ScheduleSlot, "startTime" | "endTime">[]>,
  classLogs: Pick<ClassLog, "date" | "attendance" | "durationMin">[],
  weekDateKeys: string[]
): number {
  const logByDate = new Map(classLogs.map((log) => [log.date, log] as const));
  return weekDateKeys.reduce((sum, dateKey) => {
    const log = logByDate.get(dateKey);
    if (!log || (log.attendance !== "attended" && log.attendance !== "self_study")) return sum;
    if (typeof log.durationMin === "number") return sum + log.durationMin;
    const slots = courseSlotsByDate[dateKey] ?? [];
    const blockMinutes = slots.reduce((slotSum, slot) => slotSum + Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime)), 0);
    return sum + blockMinutes;
  }, 0);
}

/**
 * Minutes of real focus-session time logged against one block, clamped to the block's own
 * duration (a session can't "cover" more of a block than the block is long). Callers must pass
 * only sessions from the date the block is being evaluated for: a recurring class/routine slot
 * reuses the same id on every date it materializes on, so an unfiltered all-time session list
 * would let a session from a past occurrence count toward today's.
 */
export function slotCoverageMinutes(slot: Pick<ScheduleSlot, "id" | "startTime" | "endTime">, sessions: Pick<PomodoroSession, "slotId" | "mode" | "minutes">[]): number {
  const slotDuration = Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime));
  const covered = sessions
    .filter((session) => session.mode === "work" && session.slotId === slot.id)
    .reduce((sum, session) => sum + session.minutes, 0);
  return Math.min(covered, slotDuration);
}

/**
 * plan/14 §6.5 — the honest alternative to flipping a block to "completed" just because its end
 * time passed (the bug `13.FocusOS-v2-UI-Coherence-Audit.md` A9 fixed). A deep-work/reading/admin
 * block completes itself once real sessions cover at least `threshold` of its duration; a class
 * block completes itself once its log says the class was attended (or self-studied). Everything
 * else is left `null` — still "past", still worth asking about in the day wrap-up — never forced
 * to "completed" by the clock alone.
 */
export function slotAutoStatus(
  slot: Pick<ScheduleSlot, "id" | "type" | "startTime" | "endTime">,
  sessions: Pick<PomodoroSession, "slotId" | "mode" | "minutes">[],
  classAttended = false,
  threshold = 0.6
): "completed" | null {
  if (slot.type === "class") return classAttended ? "completed" : null;
  const slotDuration = minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime);
  if (slotDuration <= 0) return null;
  return slotCoverageMinutes(slot, sessions) / slotDuration >= threshold ? "completed" : null;
}

/**
 * plan/16 §5.1 — minutes still owed on a piece of work: its planned total minus the real session
 * minutes logged against it.
 *
 * Deliberately minutes, not `estimatedPomodoros - completedPomodoros`. That counter advances once
 * per work session over a 5-minute floor (`finalizeSession`, components/focus-session-provider.tsx),
 * so a 6-minute session and a 50-minute session move it by exactly the same amount — the same
 * defect plan/14 §6.4 already fixed for course totals by switching them to real
 * `PomodoroSession.minutes`, which was never applied to tasks. `Task.completedPomodoros` stays as
 * it is: "how many times have I sat with this" is a genuinely useful number, just not this one.
 *
 * Break-mode sessions never count. Clamped at 0 — a task worked past its estimate owes nothing, it
 * does not owe negative time.
 */
export function loggedMinutesForTask(sessions: Pick<PomodoroSession, "mode" | "minutes" | "taskId">[], taskId: string): number {
  return sessions
    .filter((session) => session.mode === "work" && session.taskId === taskId)
    .reduce((sum, session) => sum + Math.max(0, session.minutes), 0);
}

export function remainingMinutes(totalMinutes: number, sessions: Pick<PomodoroSession, "mode" | "minutes" | "taskId">[], taskId: string): number {
  return Math.max(0, Math.round(totalMinutes - loggedMinutesForTask(sessions, taskId)));
}

/**
 * plan/16 §5.5 — how a sitting actually went, in the one vocabulary the day score (lib/gamify.ts)
 * and the sitting notification (§5.7) both count in. "Closed" is deliberately `slotAutoStatus`'s
 * own definition (real sessions covering at least 60% of the block, or an attended class) rather
 * than a second threshold living in a second place: one rule, one implementation, so a block shown
 * as complete on the timeline can never be counted as unfinished by the score beside it.
 */
export function sittingOutcome(
  slot: Pick<ScheduleSlot, "id" | "type" | "startTime" | "endTime">,
  sessions: Pick<PomodoroSession, "slotId" | "mode" | "minutes">[],
  classAttended = false
): "closed" | "partial" | "untouched" {
  if (slotAutoStatus(slot, sessions, classAttended) === "completed") return "closed";
  return slotCoverageMinutes(slot, sessions) > 0 ? "partial" : "untouched";
}

/**
 * plan/16 §5.1/§5.5 — minutes of this sitting still to do: what it was planned to contribute
 * (`plannedMinutes`, falling back to its own duration) minus what real sessions have already
 * covered. This is what arms the focus timer when a sitting is resumed, so a block already 22
 * minutes in starts a 28-minute timer rather than restarting the whole thing (§5.5).
 */
export function sittingRemainingMinutes(
  slot: Pick<ScheduleSlot, "id" | "startTime" | "endTime" | "plannedMinutes">,
  sessions: Pick<PomodoroSession, "slotId" | "mode" | "minutes">[]
): number {
  const planned = slot.plannedMinutes ?? Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime));
  return Math.max(0, planned - slotCoverageMinutes(slot, sessions));
}
