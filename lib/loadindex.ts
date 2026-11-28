import { getDay, parseISO } from "date-fns";
import { isModuleEnabled } from "@/lib/features";
import { goalTargetMinutesForDay } from "@/lib/goals";
import { MINUTES_PER_REVISION } from "@/lib/revision";
import { DEFAULT_WORKING_WINDOW } from "@/lib/weekplan";
import type { Checkpoint, Course, Goal, LoadIndexBand, LoadIndexSnapshot, RevisionItem, Term, Topic, UserSettings } from "@/types";

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
  /** plan/15 §5.1 — today is marked off (`Day.dayOff`). Short-circuits `computeRequiredMinutes` to
   *  0 before summing any of the other terms, so a day nobody intended to work reads as a clean day
   *  rather than "Behind." Optional, defaults to false — every existing caller keeps today's
   *  behavior until it's told otherwise. */
  isDayOff?: boolean;
  /** The weekdays the week planner calls working (`getDay` numbers). Weekly targets spread over
   *  these, and any other day asks only for what's planned on it. Absent = all seven. */
  workingDaysOfWeek?: number[];
}

/**
 * What a person's settings change about the Load Index, spread after the rest of the inputs. A module
 * that's off stops counting here, as it does in the planner: Goals off can't keep raising "required
 * today" from a page you can no longer reach.
 */
export function loadIndexScope(settings: Pick<UserSettings, "workingWindow" | "packId" | "enabledModules">) {
  return {
    workingDaysOfWeek: (settings.workingWindow ?? DEFAULT_WORKING_WINDOW).daysOfWeek,
    ...(isModuleEnabled(settings, "goals") ? {} : { goals: [] }),
    ...(isModuleEnabled(settings, "courses") ? {} : { courses: [], checkpoints: [] }),
    ...(isModuleEnabled(settings, "revise") ? {} : { revisionDueCount: 0, revisionsCompletedCount: 0 })
  };
}

function isNonWorkingDay(inputs: Pick<LoadIndexInputs, "todayKey" | "workingDaysOfWeek">): boolean {
  return Boolean(inputs.workingDaysOfWeek) && !inputs.workingDaysOfWeek!.includes(getDay(parseISO(inputs.todayKey)));
}

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((new Date(laterKey).getTime() - new Date(earlierKey).getTime()) / 86_400_000);
}

/** prepEstimateMin spread evenly over the checkpoint's prep lead window, summed across every checkpoint whose window covers today. */
export function checkpointPrepOwedMinutes(checkpoints: Checkpoint[], todayKey: string): number {
  return checkpoints.reduce((sum, checkpoint) => {
    if (!checkpoint.requiresPrep || checkpoint.status === "done" || checkpoint.status === "missed" || checkpoint.status === "submitted") return sum;
    const daysUntilDue = daysBetween(checkpoint.dueAt, todayKey);
    if (daysUntilDue < 0 || daysUntilDue > checkpoint.prepLeadDays || checkpoint.prepLeadDays <= 0) return sum;
    return sum + checkpoint.prepEstimateMin / checkpoint.prepLeadDays;
  }, 0);
}

/** The other half of the plan's required-minutes formula, alongside `goalTargetMinutesForDay` (lib/goals.ts) — courses carry their own weekly target independent of any goal. */
export function courseTargetMinutesForDay(courses: Course[], todayKey: string, daysInWeek = 7): number {
  const active = courses.filter((course) => {
    if (course.status === "dropped") return false;
    if (course.endDate && todayKey > course.endDate) return false;
    if (course.startDate && todayKey < course.startDate) return false;
    return true;
  });
  return active.reduce((sum, course) => sum + (course.targetMinutesPerWeek ?? 0) / daysInWeek, 0);
}

export function computeRequiredMinutes(inputs: LoadIndexInputs): number {
  if (inputs.isDayOff) return 0;
  if (isNonWorkingDay(inputs)) return inputs.scheduledDeepWorkMinutes;
  const daysInWeek = inputs.workingDaysOfWeek?.length || 7;
  return (
    inputs.scheduledDeepWorkMinutes +
    inputs.revisionDueCount * MINUTES_PER_REVISION +
    checkpointPrepOwedMinutes(inputs.checkpoints, inputs.todayKey) +
    courseTargetMinutesForDay(inputs.courses, inputs.todayKey, daysInWeek) +
    goalTargetMinutesForDay(inputs.goals ?? [], inputs.terms ?? [], inputs.todayKey, daysInWeek)
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

/**
 * Floors required at 30 minutes so a nearly-empty day doesn't divide-by-near-zero into a
 * meaningless spike — except a day off (plan/15 §5.5), where required is 0 on purpose, not
 * because too little got scheduled. Flooring that to 30 anyway would price a planned day off as
 * "Behind" (0 actual / 30 floor), which would wrongly break `computeLoadIndexStreak`'s on-track
 * streak the same week this feature was added to stop penalizing a day nobody intended to work.
 * A non-working day with nothing planned on it is the same case.
 */
export function buildLoadIndexSnapshot(inputs: LoadIndexInputs): LoadIndexSnapshot {
  const requiredMinutes = computeRequiredMinutes(inputs);
  const actualMinutes = computeActualMinutes(inputs);
  const value = inputs.isDayOff || (isNonWorkingDay(inputs) && requiredMinutes === 0) ? 1 : actualMinutes / Math.max(requiredMinutes, 30);
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

/**
 * The day records catch-up hours are measured over: only days after the person last cleared them
 * (`UserSettings.catchUpClearedOn`, the Workload card's "Clear"). The day of the clear doesn't count
 * either, so clearing on a bad evening doesn't bring that same day's shortfall back when it closes.
 * Nothing is deleted: the records stay as history, and removing the date restores the old figure.
 */
export function daysSinceCatchUpClear<T extends { date: string }>(days: T[], clearedOn?: string): T[] {
  return clearedOn ? days.filter((day) => day.date > clearedOn) : days;
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
