import { getActiveTerm } from "@/lib/terms";
import type { Goal, GoalMilestone, Term } from "@/types";

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
export function goalTargetMinutesForDay(goals: Goal[], terms: Term[], dateKey: string): number {
  return goals
    .filter((goal) => isGoalActiveForDate(goal, terms, dateKey) && goal.targetHoursPerWeek)
    .reduce((sum, goal) => sum + ((goal.targetHoursPerWeek ?? 0) * 60) / 7, 0);
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
