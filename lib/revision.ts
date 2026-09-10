import { addDays, format, parseISO } from "date-fns";
import type { Checkpoint, RevisionGrade, RevisionItem } from "@/types";

/** Modified Leitner ladder, in days between reviews. Deterministic, computed client-side — no server, no cron. */
export const DEFAULT_LADDER = [1, 3, 7, 16, 35, 70];

/** Items that fall off the end of the ladder go dormant, then resurface once, far out, at low priority. */
export const RESURFACE_AFTER_DAYS = 180;
export const RESURFACE_DAILY_CAP = 3;

export const DEFAULT_MAX_REVISIONS_PER_DAY = 20;
export const DEFAULT_MAX_REVISION_MINUTES_PER_DAY = 45;
export const MINUTES_PER_REVISION = 3;

function addDaysToKey(dateKey: string, days: number): string {
  return format(addDays(parseISO(dateKey), days), "yyyy-MM-dd");
}

function daysBetween(laterKey: string, earlierKey: string): number {
  return Math.round((parseISO(laterKey).getTime() - parseISO(earlierKey).getTime()) / 86_400_000);
}

/** Starting ladder position from a 1-5 understanding/confidence rating, per the plan's explicit anchors (5→2, 3→1, 1→0). */
export function ladderIndexForConfidence(confidence: number): number {
  if (confidence >= 5) return 2;
  if (confidence >= 3) return 1;
  return 0;
}

export function gradeRevisionItem(
  item: RevisionItem,
  grade: RevisionGrade,
  todayKey: string,
  ladder: number[] = DEFAULT_LADDER
): Partial<RevisionItem> {
  const now = new Date().toISOString();
  // Clearing retiredAt by default: only the ladder-overflow branch below re-sets it.
  // Otherwise a resurfaced item graded hard/good/easy would keep the stale flag and
  // stay wrongly capped by the resurfaced-items daily limit in buildReviewQueue.
  const base = { lastReviewedAt: now, reps: item.reps + 1, retiredAt: undefined as string | undefined };

  if (grade === "again") {
    return { ...base, ladderIndex: 0, lapses: item.lapses + 1, dueDate: addDaysToKey(todayKey, 1) };
  }
  if (grade === "hard") {
    const interval = ladder[item.ladderIndex] ?? ladder[ladder.length - 1];
    return { ...base, dueDate: addDaysToKey(todayKey, interval) };
  }

  const nextIndex = item.ladderIndex + (grade === "good" ? 1 : 2);
  if (nextIndex >= ladder.length) {
    return { ...base, ladderIndex: ladder.length - 1, dueDate: addDaysToKey(todayKey, RESURFACE_AFTER_DAYS), retiredAt: now };
  }
  return { ...base, ladderIndex: nextIndex, dueDate: addDaysToKey(todayKey, ladder[nextIndex]) };
}

export interface QueueLimits {
  maxItems: number;
  maxMinutes: number;
  minutesPerItem?: number;
}

/**
 * Builds today's review queue from every due item: caps resurfaced (retired) items
 * at RESURFACE_DAILY_CAP, pulls items forward (sort only — dueDate is never touched)
 * when a requiresPrep checkpoint they're in scope for is inside its prep lead window,
 * then clips to the daily item/minute caps.
 */
export function buildReviewQueue(dueItems: RevisionItem[], checkpoints: Checkpoint[], todayKey: string, limits: QueueLimits): RevisionItem[] {
  const active = dueItems.filter((item) => !item.retiredAt);
  const resurfaced = dueItems.filter((item) => item.retiredAt).slice(0, RESURFACE_DAILY_CAP);
  const combined = [...active, ...resurfaced];

  const boosted = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (!checkpoint.requiresPrep || checkpoint.status === "done" || checkpoint.status === "missed") continue;
    const daysUntilDue = daysBetween(checkpoint.dueAt, todayKey);
    if (daysUntilDue < 0 || daysUntilDue > checkpoint.prepLeadDays) continue;
    const scoped = checkpoint.topicIds.length > 0 ? new Set(checkpoint.topicIds) : null;
    for (const item of combined) {
      if (item.kind !== "topic" || item.courseId !== checkpoint.courseId) continue;
      if (scoped && !scoped.has(item.refId)) continue;
      boosted.add(item.id);
    }
  }

  const ordered = [...combined].sort((a, b) => {
    const boostDelta = Number(boosted.has(b.id)) - Number(boosted.has(a.id));
    if (boostDelta !== 0) return boostDelta;
    return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
  });

  const minutesPerItem = limits.minutesPerItem ?? MINUTES_PER_REVISION;
  const byCount = ordered.slice(0, limits.maxItems);
  const result: RevisionItem[] = [];
  let minutes = 0;
  for (const item of byCount) {
    if (result.length > 0 && minutes + minutesPerItem > limits.maxMinutes) break;
    result.push(item);
    minutes += minutesPerItem;
  }
  return result;
}

/** A no-model, no-input retrieval prompt — the fallback the plan specifies when there's no authored or AI-generated question. */
export function fallbackRecallPrompt(title: string): string {
  return `Explain "${title}" in two sentences, without looking anything up.`;
}
