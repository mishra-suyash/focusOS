import type { ModuleId } from "@/lib/features";
import type { Course, Day, Goal, Paper, PomodoroSession, Task } from "@/types";

export interface Nudge {
  key: string;
  message: string;
  moduleId: ModuleId;
}

export interface NudgeData {
  tasks: Task[];
  sessions: PomodoroSession[];
  papers: Paper[];
  courses: Course[];
  goals: Goal[];
  recentDays: Day[];
}

const ASSESSMENT_WORDS = /\b(quiz|exam|midsem|assignment)\b/i;

/**
 * Deterministic, rule-based contextual nudges (plan §11.1) — same philosophy as
 * `lib/ai/triage.ts`, no model call. Checked in the plan's table order; the caller picks the
 * first one that both qualifies and isn't already in `dismissedHints`.
 *
 * The plan's table has a 6th row — "3+ papers finished via Mark as read and staged reading off"
 * — deliberately omitted here: `stagedReading` is `core: true` for every pack (see
 * lib/features.ts), so `!isEnabled("stagedReading")` can never be true and "Mark as read" (the
 * off-state fallback flow it refers to) was never built. A predicate that can never fire isn't
 * worth shipping.
 */
export function computeNudges(data: NudgeData, isEnabled: (moduleId: ModuleId) => boolean): Nudge[] {
  const candidates: Nudge[] = [];

  if (data.tasks.some((task) => ASSESSMENT_WORDS.test(task.title)) && !isEnabled("courses")) {
    candidates.push({ key: "courses-assessment-tasks", message: "Taking a course? Courses can plan prep time before assessments", moduleId: "courses" });
  }

  if (data.recentDays.filter((day) => day.review?.submittedAt).length >= 5 && !isEnabled("workload")) {
    candidates.push({ key: "workload-wrapups", message: "See whether your days match your plan — turn on Workload", moduleId: "workload" });
  }

  const tagCounts = new Map<string, number>();
  for (const paper of data.papers) {
    for (const tag of paper.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  if ([...tagCounts.values()].some((count) => count >= 2) && !isEnabled("paperTools")) {
    candidates.push({ key: "paperTools-shared-tags", message: "Compare related papers side by side with a paper set", moduleId: "paperTools" });
  }

  if (data.goals.some((goal) => goal.milestones.length > 0) && !isEnabled("weeklyCheckin")) {
    candidates.push({ key: "weeklyCheckin-goal-milestones", message: "A weekly check-in keeps long goals moving", moduleId: "weeklyCheckin" });
  }

  if (data.sessions.filter((session) => session.mode === "work").length >= 15 && !isEnabled("analytics")) {
    candidates.push({ key: "analytics-sessions", message: "See your focus trends in Analytics", moduleId: "analytics" });
  }

  return candidates;
}
