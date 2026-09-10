import { adminDb } from "@/lib/firebase-admin";
import { fetchInsightData } from "@/lib/admin-firestore";
import { resolveUserTier } from "@/lib/admin-tiers";
import { evaluateTriage, type TriageAlertDraft } from "@/lib/ai/triage";
import { todayKey } from "@/lib/dates";
import { overdueMilestones } from "@/lib/goals";
import type { RevisionItem } from "@/types";

async function fetchDueRevisionCount(uid: string, today: string): Promise<number> {
  const snapshot = await adminDb()
    .collection("users")
    .doc(uid)
    .collection("revisionItems")
    .where("suspended", "==", false)
    .where("dueDate", "<=", today)
    .get();
  return snapshot.docs.map((doc) => doc.data() as RevisionItem).length;
}

/**
 * Runs the deterministic triage rules for one uid and upserts the resulting
 * alerts to `users/{uid}/alerts/{dedupeKey}` (merge, so re-running the same
 * day for the same condition updates rather than duplicates). Called from the
 * daily cron and from the manual "Regenerate insight" action — no dedicated
 * cron of its own yet, since both existing triggers already run once/uid/day.
 */
export async function evaluateAndSaveAlerts(uid: string): Promise<TriageAlertDraft[]> {
  const today = todayKey();
  const [{ days, papers, checkpoints, goals, tasks }, dueRevisionCount, { limits }] = await Promise.all([
    fetchInsightData(uid),
    fetchDueRevisionCount(uid, today),
    resolveUserTier(uid)
  ]);

  const recentLoadIndex = days
    .filter((day) => day.loadIndex)
    .map((day) => ({ date: day.date, value: day.loadIndex!.value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const stalePapers = papers
    .filter((paper) => paper.status === "reading")
    .map((paper) => ({ id: paper.id, title: paper.title, daysSinceUpdate: Math.round((Date.now() - new Date(paper.updatedAt).getTime()) / 86_400_000) }))
    .filter((paper) => paper.daysSinceUpdate > 14)
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

  const overdue = overdueMilestones(goals, today).map((m) => ({
    goalId: m.goalId,
    goalTitle: m.goalTitle,
    milestoneId: m.milestone.id,
    title: m.milestone.title,
    daysOverdue: m.daysOverdue
  }));

  const externalTasksDueSoon = tasks
    .filter((task) => task.kind === "external" && task.status !== "done" && task.dueDate)
    .map((task) => ({
      id: task.id,
      title: task.title,
      dueDate: task.dueDate!,
      hoursUntilDue: (new Date(`${task.dueDate}T23:59:59`).getTime() - Date.now()) / 3_600_000
    }))
    .filter((task) => task.hoursUntilDue > -24); // still surface a just-missed deadline for a day, don't keep it forever

  const drafts = evaluateTriage({
    todayKey: today,
    checkpoints: checkpoints.map((c) => ({ id: c.id, title: c.title, dueAt: c.dueAt, requiresPrep: c.requiresPrep, prepLeadDays: c.prepLeadDays, status: c.status })),
    dueRevisionCount,
    maxRevisionsPerDay: limits.maxRevisionsPerDay,
    recentLoadIndex,
    stalePapers,
    overdueMilestones: overdue,
    externalTasksDueSoon
  });

  const batch = adminDb().batch();
  const now = new Date().toISOString();
  const alertsRef = adminDb().collection("users").doc(uid).collection("alerts");
  for (const draft of drafts) {
    batch.set(alertsRef.doc(draft.dedupeKey), { ...draft, id: draft.dedupeKey, createdAt: now, updatedAt: now }, { merge: true });
  }
  if (drafts.length > 0) await batch.commit();

  return drafts;
}
