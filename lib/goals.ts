import { sessionSlotDayKey } from "@/lib/dates";
import { minutesFromTime } from "@/lib/schedule";
import { getActiveTerm } from "@/lib/terms";
import type { DailySchedule, Goal, GoalMilestone, PomodoroSession, ScheduleSlot, Term } from "@/types";

/**
 * A `break`-horizon goal only counts on the days its own `termId` is actually
 * the active term — everything else (week/term/year/phd) is always "live"
 * while `status: "active"`, since those horizons aren't term-scoped (plan §11.1).
 */
export function isGoalActiveForDate(goal: Goal, terms: Term[], dateKey: string): boolean {
  if (goal.status !== "active") return false;
  if (goal.horizon !== "break") return true;
  if (!goal.termId) return false;
  const activeTerm = getActiveTerm(terms, dateKey);
  return activeTerm?.id === goal.termId;
}

/** The plan's `goalTargetMinutes(day)` term — feeds lib/loadindex.ts's `computeRequiredMinutes`. */
export function goalTargetMinutesForDay(goals: Goal[], terms: Term[], dateKey: string, daysInWeek = 7): number {
  return goals
    .filter((goal) => isGoalActiveForDate(goal, terms, dateKey) && goal.targetHoursPerWeek)
    .reduce((sum, goal) => sum + ((goal.targetHoursPerWeek ?? 0) * 60) / daysInWeek, 0);
}

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((new Date(laterKey).getTime() - new Date(earlierKey).getTime()) / 86_400_000);
}

export interface OverdueMilestone {
  goalId: string;
  goalTitle: string;
  milestone: GoalMilestone;
  daysOverdue: number;
}

/** Feeds lib/ai/triage.ts's "goal milestone overdue >7 days" Critical trigger. */
export function overdueMilestones(goals: Goal[], todayKey: string): OverdueMilestone[] {
  const overdue: OverdueMilestone[] = [];
  for (const goal of goals) {
    if (goal.status !== "active") continue;
    for (const milestone of goal.milestones) {
      if (milestone.done || !milestone.dueAt) continue;
      const daysOverdue = daysBetween(todayKey, milestone.dueAt);
      if (daysOverdue > 0) overdue.push({ goalId: goal.id, goalTitle: goal.title, milestone, daysOverdue });
    }
  }
  return overdue;
}

/** Feeds the morning brief's "goal milestones this week" list. */
export function upcomingMilestones(goals: Goal[], todayKey: string, withinDays: number): OverdueMilestone[] {
  const upcoming: OverdueMilestone[] = [];
  for (const goal of goals) {
    if (goal.status !== "active") continue;
    for (const milestone of goal.milestones) {
      if (milestone.done || !milestone.dueAt) continue;
      const daysUntil = daysBetween(milestone.dueAt, todayKey);
      if (daysUntil >= 0 && daysUntil <= withinDays) {
        upcoming.push({ goalId: goal.id, goalTitle: goal.title, milestone, daysOverdue: -daysUntil });
      }
    }
  }
  return upcoming;
}

export interface GoalPace {
  goalId: string;
  title: string;
  targetMinutes: number;
  /** Minutes of blocks for this goal still ahead this week. */
  plannedMinutes: number;
  /** Focus minutes already logged toward it this week. */
  loggedMinutes: number;
  /** Set when the week is behind: nothing planned or logged after Monday, or under half the target from Wednesday on. */
  warning?: string;
}

/**
 * How a goal's weekly hours are going (mid-week pace). A goal's time is its own blocks
 * (`objectiveRef.kind === "goal"`) plus goal-bucket work in its linked courses, the same two routes the
 * weekly planner books it through. Logged = focus sessions in those blocks or tagged to that bucket,
 * each counted once. Planned = those blocks still ahead (a block behind you counts only through what
 * was logged in it). The warning fires from Tuesday when nothing at all is planned or logged, and from
 * Wednesday when planned + logged is under half the target.
 */
export function goalWeekPace(params: {
  goals: Pick<Goal, "id" | "title" | "status" | "targetHoursPerWeek" | "linked">[];
  schedules: Pick<DailySchedule, "dateKey" | "slots">[];
  sessions: Pick<PomodoroSession, "slotId" | "slotDateKey" | "completedAt" | "mode" | "minutes" | "courseId" | "bucket">[];
  weekDateKeys: string[];
  todayKey: string;
  nowMinutes: number;
}): GoalPace[] {
  const { goals, schedules, sessions, weekDateKeys, todayKey, nowMinutes } = params;
  const inWeek = new Set(weekDateKeys);
  const dayIndex = weekDateKeys.indexOf(todayKey);
  return goals
    .filter((goal) => goal.status === "active" && goal.targetHoursPerWeek)
    .map((goal) => {
      const courseIds = new Set(goal.linked.courseIds);
      const isGoalSlot = (slot: ScheduleSlot) => (slot.objectiveRef?.kind === "goal" && slot.objectiveRef.id === goal.id) || (slot.bucket === "goal" && !!slot.courseId && courseIds.has(slot.courseId));
      const goalSlots = schedules.filter((s) => inWeek.has(s.dateKey)).flatMap((s) => s.slots.filter(isGoalSlot).map((slot) => ({ slot, dateKey: s.dateKey })));
      const ahead = goalSlots.filter(({ slot, dateKey }) => dateKey > todayKey || (dateKey === todayKey && minutesFromTime(slot.endTime) > nowMinutes));
      const plannedMinutes = ahead.reduce((sum, { slot }) => sum + Math.max(0, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime)), 0);
      const slotKeys = new Set(goalSlots.map(({ slot, dateKey }) => `${dateKey}|${slot.id}`));
      const loggedMinutes = sessions
        .filter((session) => session.mode === "work" && inWeek.has(sessionSlotDayKey(session)))
        .filter((session) => (session.slotId && slotKeys.has(`${sessionSlotDayKey(session)}|${session.slotId}`)) || (session.bucket === "goal" && !!session.courseId && courseIds.has(session.courseId)))
        .reduce((sum, session) => sum + session.minutes, 0);
      const targetMinutes = (goal.targetHoursPerWeek ?? 0) * 60;
      const covered = plannedMinutes + loggedMinutes;
      const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`;
      const warning =
        dayIndex >= 1 && covered === 0
          ? `Nothing planned or logged for "${goal.title}" this week (target ${hours(targetMinutes)}).`
          : dayIndex >= 2 && covered < targetMinutes / 2
            ? `"${goal.title}" is behind: ${hours(covered)} planned or logged of ${hours(targetMinutes)} this week.`
            : undefined;
      return { goalId: goal.id, title: goal.title, targetMinutes, plannedMinutes, loggedMinutes, ...(warning ? { warning } : {}) };
    });
}
