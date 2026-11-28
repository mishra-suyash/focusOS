/**
 * plan/20 §2: what a day's blocks plan, as Workload's required minutes reads it.
 *
 * Every scored sitting (deep work, reading, admin: the day score's own set, `isScoredSitting`) counts at
 * its planned minutes, and so does whatever it's booked toward. The standing targets (revision due,
 * assessment prep, a course's revision share, a goal's share) then ask only for what the blocks don't
 * already cover, so a goal sitting isn't counted once as a block and again as the goal's daily share.
 *
 * Not counted: a tentative block (held time, not planned work), a skipped block (the person said it
 * isn't happening; the targets still apply), a rescheduled original (its copy carries the work), and the
 * locked and fixed layer (the weekly-planning anchor is a locked admin block, not planned focus work).
 */
import { isScoredSitting } from "@/lib/gamify";
import { isFixedSlot } from "@/lib/schedule";
import { sittingPlannedMinutes } from "@/lib/tracking";
import type { Paper, ScheduleSlot } from "@/types";

export interface PlannedWork {
  /** Minutes of every counted sitting. */
  minutes: number;
  /** Sittings working the spaced-revision queue. */
  revisionQueue: number;
  /** Prep sittings, by checkpoint id. */
  byCheckpoint: Record<string, number>;
  /** Revision-bucket sittings, by course id. */
  byCourseRevision: Record<string, number>;
  /** Goal-bucket sittings, by course id (a goal's linked courses resolve these to the goal). */
  byGoalCourse: Record<string, number>;
  /** Sittings with a goal objective, or a paper objective on a paper linked to that goal (`Paper.goalId`). */
  byGoal: Record<string, number>;
}

export const NO_PLANNED_WORK: PlannedWork = { minutes: 0, revisionQueue: 0, byCheckpoint: {}, byCourseRevision: {}, byGoalCourse: {}, byGoal: {} };

/** A block that counts as planned work: a scored sitting the person placed, not held softly, skipped or moved. */
export function isPlannedSitting(slot: Pick<ScheduleSlot, "id" | "type" | "status" | "tentative" | "rescheduledTo" | "locked">): boolean {
  if (slot.locked || isFixedSlot(slot) || slot.id === "weekly-planning") return false;
  return isScoredSitting(slot) && !slot.tentative && slot.status !== "skipped" && !slot.rescheduledTo;
}

function add(record: Record<string, number>, key: string, minutes: number) {
  record[key] = (record[key] ?? 0) + minutes;
}

export function plannedWorkOf(slots: ScheduleSlot[], papers: Pick<Paper, "id" | "goalId">[] = []): PlannedWork {
  const goalOfPaper = new Map(papers.filter((paper) => paper.goalId).map((paper) => [paper.id, paper.goalId!]));
  const work: PlannedWork = { minutes: 0, revisionQueue: 0, byCheckpoint: {}, byCourseRevision: {}, byGoalCourse: {}, byGoal: {} };
  for (const slot of slots) {
    if (!isPlannedSitting(slot)) continue;
    const minutes = sittingPlannedMinutes(slot);
    work.minutes += minutes;
    const ref = slot.objectiveRef;
    if (ref?.kind === "revisionQueue") work.revisionQueue += minutes;
    else if (ref?.kind === "checkpoint") add(work.byCheckpoint, ref.id, minutes);
    else if (ref?.kind === "goal") add(work.byGoal, ref.id, minutes);
    else if (ref?.kind === "paper" && goalOfPaper.has(ref.id)) add(work.byGoal, goalOfPaper.get(ref.id)!, minutes);
    if (slot.courseId && slot.bucket === "revision") add(work.byCourseRevision, slot.courseId, minutes);
    if (slot.courseId && slot.bucket === "goal") add(work.byGoalCourse, slot.courseId, minutes);
  }
  return work;
}

/** Only the total, for a caller that has nothing to net (a non-working day's ask, a test). */
export function plannedMinutesOnly(minutes: number): PlannedWork {
  return { ...NO_PLANNED_WORK, minutes };
}
