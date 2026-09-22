import { goalTargetMinutesForDay } from "@/lib/goals";
import { MINUTES_PER_REVISION } from "@/lib/revision";
import type { Checkpoint, Course, Goal, LoadIndexBand, LoadIndexSnapshot, RevisionItem, Term, Topic } from "@/types";

export interface LoadIndexInputs {
  scheduledDeepWorkMinutes: number;
  revisionDueCount: number;
  revisionsCompletedCount: number;
  checkpoints: Checkpoint[];
  courses: Course[];
  focusedMinutes: number;
  todayKey: string;
  /** Optional — omitted callers simply get 0 for the goal-target term, same as before Goals existed. */
  goals?: Goal[];
  terms?: Term[];
}

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((new Date(laterKey).getTime() - new Date(earlierKey).getTime()) / 86_400_000);
}

/** prepEstimateMin spread evenly over the checkpoint's prep lead window, summed across every checkpoint whose window covers today. */
export function checkpointPrepOwedMinutes(checkpoints: Checkpoint[], todayKey: string): number {
  return checkpoints.reduce((sum, checkpoint) => {
    if (!checkpoint.requiresPrep || checkpoint.status === "done" || checkpoint.status === "missed") return sum;
    const daysUntilDue = daysBetween(checkpoint.dueAt, todayKey);
    if (daysUntilDue < 0 || daysUntilDue > checkpoint.prepLeadDays || checkpoint.prepLeadDays <= 0) return sum;
    return sum + checkpoint.prepEstimateMin / checkpoint.prepLeadDays;
  }, 0);
}

/** The other half of the plan's required-minutes formula, alongside `goalTargetMinutesForDay` (lib/goals.ts) — courses carry their own weekly target independent of any goal. */
export function courseTargetMinutesForDay(courses: Course[], todayKey: string): number {
  const active = courses.filter((course) => {
    if (course.status === "dropped") return false;
    if (course.endDate && todayKey > course.endDate) return false;
    if (course.startDate && todayKey < course.startDate) return false;
    return true;
  });
  return active.reduce((sum, course) => sum + (course.targetMinutesPerWeek ?? 0) / 7, 0);
}

export function computeRequiredMinutes(inputs: LoadIndexInputs): number {
  return (
    inputs.scheduledDeepWorkMinutes +
    inputs.revisionDueCount * MINUTES_PER_REVISION +
    checkpointPrepOwedMinutes(inputs.checkpoints, inputs.todayKey) +
    courseTargetMinutesForDay(inputs.courses, inputs.todayKey) +
    goalTargetMinutesForDay(inputs.goals ?? [], inputs.terms ?? [], inputs.todayKey)
  );
}

export function computeActualMinutes(inputs: Pick<LoadIndexInputs, "focusedMinutes" | "revisionsCompletedCount">): number {
  return inputs.focusedMinutes + inputs.revisionsCompletedCount * MINUTES_PER_REVISION;
}

export function loadIndexBand(value: number): LoadIndexBand {
  if (value < 0.6) return "behind";
  if (value < 0.9) return "light";
  if (value <= 1.15) return "on_track";
  if (value <= 1.5) return "ahead";
  return "overrun";
}

export const loadIndexBandLabels: Record<LoadIndexBand, string> = {
  behind: "Behind",
  light: "Light day",
  on_track: "On track",
  ahead: "Ahead",
  overrun: "Overrun"
};

export const loadIndexBandStyles: Record<LoadIndexBand, string> = {
  behind: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  light: "bg-amberline/15 text-amber-700 dark:text-amber-300",
  on_track: "bg-moss-600/10 text-moss-700 dark:text-moss-400",
  ahead: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  overrun: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
};

/** Floors required at 30 minutes so a nearly-empty day doesn't divide-by-near-zero into a meaningless spike. */
export function buildLoadIndexSnapshot(inputs: LoadIndexInputs): LoadIndexSnapshot {
  const requiredMinutes = computeRequiredMinutes(inputs);
  const actualMinutes = computeActualMinutes(inputs);
  const value = actualMinutes / Math.max(requiredMinutes, 30);
  return {
    requiredMinutes: Math.round(requiredMinutes),
    actualMinutes: Math.round(actualMinutes),
    value: Number(value.toFixed(2)),
    band: loadIndexBand(value),
    computedAt: new Date().toISOString()
  };
}

const DEBT_WINDOW_DAYS = 14;
const DEBT_CAP_HOURS = 40;

/**
 * Rolling 14-day sum of shortfall (plan §10.2), in hours, capped so a long
 * dry spell doesn't grow into an illegible number. `history` reads directly
 * off the already-stored `Day.loadIndex` snapshots — no new Firestore field.
 */
export function computeDebtHours(history: Pick<LoadIndexSnapshot, "requiredMinutes" | "actualMinutes">[]): number {
  const window = history.slice(-DEBT_WINDOW_DAYS);
  const shortfallMinutes = window.reduce((sum, day) => sum + Math.max(0, day.requiredMinutes - day.actualMinutes), 0);
  return Math.min(DEBT_CAP_HOURS, Number((shortfallMinutes / 60).toFixed(1)));
}

/** Consecutive most-recent days with LI >= 0.9 (plan §10.2's streak, replacing the old pomodoro streak). `history` must be chronological, most recent last. */
export function computeLoadIndexStreak(history: Pick<LoadIndexSnapshot, "value">[]): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].value < 0.9) break;
    streak += 1;
  }
  return streak;
}

/**
 * `topics revised >= 1 time / topics logged` for one course (plan §10.2) —
 * "revised" means the topic's linked RevisionItem has at least one completed
 * rep, not just that a revision item exists for it.
 */
export function computeCourseCoverage(topics: Topic[], revisionItems: RevisionItem[], courseId: string): number {
  const courseTopics = topics.filter((topic) => topic.courseId === courseId && topic.status !== "retired");
  if (courseTopics.length === 0) return 0;
  const revisionById = new Map(revisionItems.map((item) => [item.id, item]));
  const revisedCount = courseTopics.filter((topic) => {
    const item = topic.revisionItemId ? revisionById.get(topic.revisionItemId) : undefined;
    return (item?.reps ?? 0) >= 1;
  }).length;
  return Number((revisedCount / courseTopics.length).toFixed(2));
}
