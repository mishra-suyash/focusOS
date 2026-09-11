import { adminDb } from "@/lib/firebase-admin";
import { fetchInsightData } from "@/lib/admin-firestore";
import { buildMorningBrief, buildProposedSlots, buildProposedTasks } from "@/lib/dailyloop";
import { todayKey } from "@/lib/dates";
import { buildLoadIndexSnapshot, computeRequiredMinutes } from "@/lib/loadindex";
import { runAiTask } from "@/lib/ai/run";
import type { ReviewEodOutput } from "@/lib/ai/schemas";
import { scheduleSummary } from "@/lib/schedule";
import type { DailySchedule, EveningRollup, MorningBrief, PomodoroSession, Task } from "@/types";

async function fetchDueRevisionCount(uid: string, dateKey: string): Promise<number> {
  const snapshot = await adminDb()
    .collection("users")
    .doc(uid)
    .collection("revisionItems")
    .where("suspended", "==", false)
    .where("dueDate", "<=", dateKey)
    .get();
  return snapshot.size;
}

async function fetchDailySchedule(uid: string, dateKey: string): Promise<DailySchedule | null> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("dailySchedules").doc(dateKey).get();
  return snapshot.exists ? ({ id: snapshot.id, ...snapshot.data() } as DailySchedule) : null;
}

async function fetchRevisionsCompletedCount(uid: string, dateKey: string): Promise<number> {
  const snapshot = await adminDb()
    .collection("users")
    .doc(uid)
    .collection("revisionItems")
    .where("lastReviewedAt", ">=", `${dateKey}T00:00:00.000Z`)
    .get();
  return snapshot.size;
}

async function fetchUnresolvedCriticalAlertCount(uid: string): Promise<number> {
  const snapshot = await adminDb()
    .collection("users")
    .doc(uid)
    .collection("alerts")
    .where("severity", "==", "critical")
    .get();
  return snapshot.docs.filter((doc) => !doc.data().resolvedAt).length;
}

function dayMetrics(tasks: Task[], sessions: PomodoroSession[], dateKey: string) {
  const daysSessions = sessions.filter((session) => session.completedAt.startsWith(dateKey));
  const completedTasks = tasks.filter((task) => task.completedAt?.startsWith(dateKey));
  return {
    pomodoros: daysSessions.filter((session) => session.mode === "work").length,
    focusedMinutes: daysSessions.reduce((sum, session) => sum + (session.mode === "work" ? session.minutes : 0), 0),
    tasksCompleted: completedTasks.length
  };
}

/** Deterministic, no AI call — see lib/dailyloop.ts. Writes to days/{today}.brief. */
export async function generateMorningBrief(uid: string): Promise<MorningBrief> {
  const today = todayKey();
  const [{ checkpoints, papers, goals, tasks, courses, terms }, dueRevisionCount, schedule, unresolvedCriticalAlertCount] = await Promise.all([
    fetchInsightData(uid),
    fetchDueRevisionCount(uid, today),
    fetchDailySchedule(uid, today),
    fetchUnresolvedCriticalAlertCount(uid)
  ]);

  const requiredMinutesTarget = computeRequiredMinutes({
    scheduledDeepWorkMinutes: scheduleSummary(schedule?.slots ?? []).plannedDeepWork,
    revisionDueCount: dueRevisionCount,
    revisionsCompletedCount: 0,
    checkpoints,
    courses,
    goals,
    terms,
    focusedMinutes: 0,
    todayKey: today
  });

  const brief = buildMorningBrief({
    todayKey: today,
    dueRevisionCount,
    checkpoints,
    papers,
    goals,
    externalTasks: tasks,
    unresolvedCriticalAlertCount,
    requiredMinutesTarget
  });

  await adminDb().collection("users").doc(uid).collection("days").doc(today).set({ date: today, brief, updatedAt: new Date().toISOString() }, { merge: true });
  return brief;
}

/**
 * `proposedTasks`/`proposedSlots`/`unloggedClasses` are always deterministic
 * (lib/dailyloop.ts); only `summary`/`improvements` come from the `review.eod`
 * AI task, which already has its own numeric fallback if no provider is
 * available. `unloggedClasses` is a documented cut — always `[]` for now, same
 * as lib/ai/triage.ts's "2+ unlogged classes" trigger; both need an extra
 * per-course classLog read this pass didn't add.
 */
export async function generateEveningRollup(uid: string): Promise<EveningRollup> {
  const today = todayKey();
  const yesterday = todayKey(new Date(Date.now() - 86_400_000));

  const [{ checkpoints, tasks, sessions, courses, goals, terms }, dueRevisionCount, dayDoc, schedule] = await Promise.all([
    fetchInsightData(uid),
    fetchDueRevisionCount(uid, today),
    adminDb().collection("users").doc(uid).collection("days").doc(today).get(),
    fetchDailySchedule(uid, today)
  ]);

  const checkpointsNeedingPrep = checkpoints.filter((c) => {
    if (!c.requiresPrep || c.status === "done" || c.status === "missed") return false;
    const daysUntil = Math.round((new Date(c.dueAt).getTime() - new Date(today).getTime()) / 86_400_000);
    return daysUntil >= 0 && daysUntil <= c.prepLeadDays;
  });
  const dueTasks = tasks.filter((t) => t.status !== "done" && t.dueDate && t.dueDate <= today);

  const proposedTasks = buildProposedTasks({ todayKey: today, dueTasks, checkpointsNeedingPrep, dueRevisionCount });
  const proposedSlots = buildProposedSlots({ checkpointsNeedingPrep, dueRevisionCount });

  const todayStats = dayMetrics(tasks, sessions, today);
  const yesterdayStats = dayMetrics(tasks, sessions, yesterday);

  // F7 (plan §11.2) — End day was the only place a Load Index snapshot got written; someone who
  // forgets it leaves Workload/analytics history with a gap for the day. Back it in here from the
  // same inputs generateMorningBrief/the client's End day use.
  //
  // Gated on `session.endedAt`, not on whether `loadIndex` already exists: F11's Undo (plan
  // §11.2) clears `session.endedAt` but deliberately leaves the snapshot End day already wrote,
  // so a day that was ended, undone, and never re-ended would otherwise look "already snapshotted"
  // to a presence check and keep that stale, too-early number as its permanent record — recomputing
  // is idempotent, so there's no cost to redoing it whenever the day wasn't properly closed. This
  // deliberately overwrites any snapshot already sitting there for a not-properly-ended day — a
  // 22:00 recompute over the full day is strictly more accurate than whatever partial number an
  // earlier End day (since undone) left behind.
  const dayData = dayDoc.data();
  let loadIndexValue = dayData?.loadIndex?.value as number | undefined;
  if (!dayData?.session?.endedAt || loadIndexValue === undefined) {
    const revisionsCompletedCount = await fetchRevisionsCompletedCount(uid, today);
    const snapshot = buildLoadIndexSnapshot({
      scheduledDeepWorkMinutes: scheduleSummary(schedule?.slots ?? []).plannedDeepWork,
      revisionDueCount: dueRevisionCount,
      revisionsCompletedCount,
      checkpoints,
      courses,
      goals,
      terms,
      focusedMinutes: todayStats.focusedMinutes,
      todayKey: today
    });
    await adminDb().collection("users").doc(uid).collection("days").doc(today).set({ loadIndex: snapshot, date: today, updatedAt: new Date().toISOString() }, { merge: true });
    loadIndexValue = snapshot.value;
  }

  const { output, meta } = await runAiTask(uid, "review.eod", {
    today: { ...todayStats, loadIndex: loadIndexValue },
    yesterday: yesterdayStats
  });
  const result = output as ReviewEodOutput;

  const rollup: EveningRollup = {
    generatedAt: new Date().toISOString(),
    provider: meta.provider,
    degraded: meta.degraded,
    summary: result.summary,
    improvements: result.watchouts.map((text) => ({ text, severity: "important" as const })),
    proposedTasks,
    proposedSlots,
    unloggedClasses: []
  };

  await adminDb().collection("users").doc(uid).collection("days").doc(today).set({ date: today, rollup, updatedAt: new Date().toISOString() }, { merge: true });
  return rollup;
}
