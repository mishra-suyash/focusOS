import { upcomingMilestones } from "@/lib/goals";
import type { Checkpoint, Goal, MorningBrief, Paper, ProposedSlot, ProposedTask, Task } from "@/types";

/**
 * Pure builders for the daily loop (plan §10.1). The morning brief is
 * entirely deterministic — no AI call at all — since it's a structured
 * readout of data that already exists elsewhere, not something that benefits
 * from being generated. The evening rollup's `proposedTasks`/`proposedSlots`
 * are deterministic too, for the same "no feature is AI-only" reason the rest
 * of the AI layer follows: what's actually accept-able into tomorrow's plan
 * must never depend on an AI call succeeding. Only the rollup's prose
 * `summary`/`improvements` come from the `review.eod` AI task (lib/ai/tasks.ts),
 * which already has its own deterministic fallback.
 */

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((new Date(laterKey).getTime() - new Date(earlierKey).getTime()) / 86_400_000);
}

export interface MorningBriefInputs {
  todayKey: string;
  dueRevisionCount: number;
  checkpoints: Checkpoint[];
  papers: Paper[];
  goals: Goal[];
  externalTasks: Task[];
  unresolvedCriticalAlertCount: number;
  requiredMinutesTarget: number;
}

export function buildMorningBrief(inputs: MorningBriefInputs): MorningBrief {
  const checkpointsInWindow = inputs.checkpoints
    .filter((c) => c.requiresPrep && c.status !== "done" && c.status !== "missed")
    .filter((c) => {
      const daysUntil = daysBetween(c.dueAt, inputs.todayKey);
      return daysUntil >= 0 && daysUntil <= c.prepLeadDays;
    })
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))
    .map((c) => ({ id: c.id, title: c.title, dueAt: c.dueAt }));

  const papersScheduled = inputs.papers.filter((p) => p.status === "reading").map((p) => ({ id: p.id, title: p.title }));

  const goalMilestonesThisWeek = upcomingMilestones(inputs.goals, inputs.todayKey, 7).map((m) => ({
    goalId: m.goalId,
    goalTitle: m.goalTitle,
    milestoneId: m.milestone.id,
    title: m.milestone.title,
    dueAt: m.milestone.dueAt
  }));

  const externalTasksInWindow = inputs.externalTasks
    .filter((t) => t.kind === "external" && t.status !== "done" && t.dueDate)
    .filter((t) => {
      const daysUntil = daysBetween(t.dueDate!, inputs.todayKey);
      const leadDays = t.reminderLeadDays ?? [7, 2, 0];
      return daysUntil >= 0 && leadDays.some((lead) => daysUntil <= lead);
    })
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1))
    .map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate! }));

  return {
    generatedAt: new Date().toISOString(),
    revisionsDue: inputs.dueRevisionCount,
    checkpointsInWindow,
    papersScheduled,
    goalMilestonesThisWeek,
    externalTasksInWindow,
    unresolvedCriticalAlerts: inputs.unresolvedCriticalAlertCount,
    requiredMinutesTarget: Math.round(inputs.requiredMinutesTarget)
  };
}

export interface ProposedTasksInputs {
  todayKey: string;
  dueTasks: Task[];
  checkpointsNeedingPrep: Checkpoint[];
  dueRevisionCount: number;
}

/** Same sorted-by-urgency shape as `plan.tomorrow`'s AI-task fallback (lib/ai/tasks.ts), but structured (title/category/pomodoros) instead of plain strings, since these need to become real Task docs on Accept. */
export function buildProposedTasks(inputs: ProposedTasksInputs): ProposedTask[] {
  const proposals: ProposedTask[] = [];

  const sortedCheckpoints = [...inputs.checkpointsNeedingPrep].sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  for (const checkpoint of sortedCheckpoints) {
    const daysUntil = daysBetween(checkpoint.dueAt, inputs.todayKey);
    proposals.push({
      title: `Prep: ${checkpoint.title}`,
      category: "research",
      estimatePomodoros: 2,
      severity: daysUntil <= 2 ? "critical" : "important"
    });
  }

  const sortedTasks = [...inputs.dueTasks]
    .filter((t) => t.status !== "done")
    .sort((a, b) => (a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : 1)
    .slice(0, 5);
  for (const task of sortedTasks) {
    proposals.push({
      title: task.title,
      category: task.category,
      estimatePomodoros: task.estimatedPomodoros ?? 1,
      severity: task.priority === "high" ? "important" : "general"
    });
  }

  if (inputs.dueRevisionCount > 0) {
    proposals.push({
      title: `Review ${inputs.dueRevisionCount} due revision item${inputs.dueRevisionCount === 1 ? "" : "s"}`,
      category: "research",
      estimatePomodoros: Math.max(1, Math.ceil(inputs.dueRevisionCount / 8)),
      severity: "general"
    });
  }

  return proposals.slice(0, 8);
}

export interface ProposedSlotsInputs {
  checkpointsNeedingPrep: Checkpoint[];
  dueRevisionCount: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Fills Phase 1's explicitly-deferred gap: auto-generated "prep block"
 * schedule slots for checkpoints, now that this Accept/Edit/Dismiss flow
 * exists to review them before anything touches the calendar. Times are
 * placeholder defaults (early evening, sequential) — the UI lets you edit
 * start/end before accepting, this never writes to a schedule directly.
 */
export function buildProposedSlots(inputs: ProposedSlotsInputs): ProposedSlot[] {
  const slots: ProposedSlot[] = [];
  let hour = 17;

  const sortedCheckpoints = [...inputs.checkpointsNeedingPrep].sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1)).slice(0, 2);
  for (const checkpoint of sortedCheckpoints) {
    slots.push({
      title: `Prep: ${checkpoint.title}`,
      type: "deep_work",
      startTime: `${pad(hour)}:00`,
      endTime: `${pad(hour)}:45`,
      refType: "checkpoint",
      refId: checkpoint.id
    });
    hour += 1;
  }

  if (inputs.dueRevisionCount > 0) {
    slots.push({
      title: "Review revisions",
      type: "deep_work",
      startTime: `${pad(hour)}:00`,
      endTime: `${pad(hour)}:30`,
      refType: "revision"
    });
  }

  return slots;
}
