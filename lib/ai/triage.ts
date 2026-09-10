import type { AlertSeverity, AlertType } from "@/types";

/**
 * Deterministic triage rules (plan §9.4). These run first and are the ground
 * truth — the optional `triage.actions` AI task (lib/ai/tasks.ts) may only
 * re-word or re-order within the same severity band, never downgrade one.
 *
 * Scoped to what's buildable from subsystems that exist today (courses,
 * checkpoints, revision engine, Load Index, papers, and — as of Phase 6 —
 * goals and external tasks). "Weekly review missed" and "2+ unlogged classes"
 * are still deferred — buildable, but would each need an extra per-course
 * Firestore read this module doesn't otherwise require.
 */

export interface TriageCheckpoint {
  id: string;
  title: string;
  dueAt: string;
  requiresPrep: boolean;
  prepLeadDays: number;
  status: string;
}

export interface TriageStalePaper {
  id: string;
  title: string;
  daysSinceUpdate: number;
}

export interface TriageOverdueMilestone {
  goalId: string;
  goalTitle: string;
  milestoneId: string;
  title: string;
  daysOverdue: number;
}

export interface TriageExternalTask {
  id: string;
  title: string;
  dueDate: string;
  hoursUntilDue: number;
}

export interface TriageLoadIndexDay {
  date: string;
  value: number;
}

export interface TriageInput {
  todayKey: string;
  checkpoints: TriageCheckpoint[];
  dueRevisionCount: number;
  maxRevisionsPerDay: number;
  recentLoadIndex: TriageLoadIndexDay[]; // chronological, most recent last
  stalePapers: TriageStalePaper[];
  overdueMilestones: TriageOverdueMilestone[];
  externalTasksDueSoon: TriageExternalTask[];
}

export interface TriageAlertDraft {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  detail: string;
  refId?: string;
  dedupeKey: string;
}

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((new Date(laterKey).getTime() - new Date(earlierKey).getTime()) / 86_400_000);
}

function dedupeKey(type: AlertType, refId: string, todayKey: string): string {
  return `${type}:${refId}:${todayKey}`;
}

export function evaluateTriage(input: TriageInput): TriageAlertDraft[] {
  const { todayKey } = input;
  const alerts: TriageAlertDraft[] = [];

  for (const checkpoint of input.checkpoints) {
    if (!checkpoint.requiresPrep || checkpoint.status === "done" || checkpoint.status === "missed" || checkpoint.status === "submitted") continue;
    const daysUntil = daysBetween(checkpoint.dueAt, todayKey);
    if (daysUntil < 0 || daysUntil > checkpoint.prepLeadDays) continue;
    if (daysUntil <= 2 && checkpoint.status !== "prepping") {
      alerts.push({
        type: "checkpoint.prep_overdue",
        severity: "critical",
        title: `${checkpoint.title} due in ${daysUntil} day${daysUntil === 1 ? "" : "s"} — prep barely started`,
        detail: `Status is still "${checkpoint.status}" with the checkpoint due ${checkpoint.dueAt}.`,
        refId: checkpoint.id,
        dedupeKey: dedupeKey("checkpoint.prep_overdue", checkpoint.id, todayKey)
      });
    } else if (checkpoint.status === "upcoming") {
      alerts.push({
        type: "checkpoint.prep_not_started",
        severity: "important",
        title: `${checkpoint.title} is in its prep window`,
        detail: `Due ${checkpoint.dueAt}, ${daysUntil} day${daysUntil === 1 ? "" : "s"} out, and no prep started yet.`,
        refId: checkpoint.id,
        dedupeKey: dedupeKey("checkpoint.prep_not_started", checkpoint.id, todayKey)
      });
    }
  }

  if (input.dueRevisionCount > input.maxRevisionsPerDay * 2) {
    alerts.push({
      type: "revision.backlog",
      severity: "critical",
      title: `Revision backlog is ${input.dueRevisionCount} items`,
      detail: `More than double your daily cap of ${input.maxRevisionsPerDay}. Consider a longer session or suspending low-value items.`,
      dedupeKey: dedupeKey("revision.backlog", "queue", todayKey)
    });
  }

  const lastThree = input.recentLoadIndex.slice(-3);
  if (lastThree.length === 3 && lastThree.every((day) => day.value < 0.5)) {
    alerts.push({
      type: "load_index.low_streak",
      severity: "critical",
      title: "3 days running below half your target load",
      detail: `Load Index: ${lastThree.map((d) => `${d.date}=${d.value}`).join(", ")}.`,
      dedupeKey: dedupeKey("load_index.low_streak", "streak", todayKey)
    });
  } else if (lastThree.length === 3 && lastThree.every((day) => day.value < 0.9 || day.value > 1.15)) {
    alerts.push({
      type: "load_index.off_track",
      severity: "important",
      title: "Load Index has been off-track for 3 days",
      detail: `Outside the 0.9–1.15 on-track band: ${lastThree.map((d) => `${d.date}=${d.value}`).join(", ")}.`,
      dedupeKey: dedupeKey("load_index.off_track", "streak", todayKey)
    });
  }

  for (const milestone of input.overdueMilestones) {
    if (milestone.daysOverdue <= 7) continue;
    alerts.push({
      type: "goal.milestone_overdue",
      severity: "critical",
      title: `"${milestone.title}" is ${milestone.daysOverdue} days overdue`,
      detail: `Milestone for goal "${milestone.goalTitle}" — reschedule it or mark the goal paused if it's no longer live.`,
      refId: milestone.milestoneId,
      dedupeKey: dedupeKey("goal.milestone_overdue", milestone.milestoneId, todayKey)
    });
  }

  for (const task of input.externalTasksDueSoon) {
    if (task.hoursUntilDue > 24) continue;
    alerts.push({
      type: "task.external_due",
      severity: "critical",
      title: `"${task.title}" is due within 24 hours`,
      detail: `Due ${task.dueDate}. This is an external deadline, not study time — don't let it slip.`,
      refId: task.id,
      dedupeKey: dedupeKey("task.external_due", task.id, todayKey)
    });
  }

  for (const paper of input.stalePapers.slice(0, 3)) {
    alerts.push({
      type: "paper.stale",
      severity: "important",
      title: `"${paper.title}" untouched for ${paper.daysSinceUpdate} days`,
      detail: "Still marked as reading. Finish it, park it, or drop it so it stops silently occupying the queue.",
      refId: paper.id,
      dedupeKey: dedupeKey("paper.stale", paper.id, todayKey)
    });
  }

  return alerts;
}
