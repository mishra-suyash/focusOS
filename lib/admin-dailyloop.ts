import { adminDb } from "@/lib/firebase-admin";
import { fetchInsightData } from "@/lib/admin-firestore";
import { buildMorningBrief, buildProposedSlots, buildProposedTasks } from "@/lib/dailyloop";
import { addDaysToKey, zonedDayKey, zonedMinute } from "@/lib/dates";
import { isModuleEnabled } from "@/lib/features";
import { computeDayScore } from "@/lib/gamify";
import { DEFAULT_TIMEZONE } from "@/lib/google-calendar";
import { buildLoadIndexSnapshot, computeRequiredMinutes, loadIndexScope } from "@/lib/loadindex";
import { runAiTask } from "@/lib/ai/run";
import type { ReviewEodOutput } from "@/lib/ai/schemas";
import { scheduleSummary } from "@/lib/schedule";
import type { DailySchedule, Day, EveningRollup, MorningBrief, PomodoroSession, Task, UserSettings } from "@/types";

/** How far back close-day looks: the day that just ended, and one a run landing early left open. */
const CLOSE_LOOKBACK_DAYS = 2;

export async function fetchSettings(uid: string): Promise<Partial<UserSettings>> {
  const doc = await adminDb().collection("users").doc(uid).collection("meta").doc("settings").get();
  return (doc.data() ?? {}) as Partial<UserSettings>;
}

/**
 * The server runs in UTC, so a day is worked out for the person: `lib/dates.ts`'s `todayKey` here would
 * give the UTC date, and the same session day-keys the client derives wouldn't line up. `at` turns a
 * timestamp into their day; `sessionDay` and `slotDay` are `sessionDayKey`/`sessionSlotDayKey` in their zone.
 *
 * plan/19 §5.1 — exported so the MCP server and the crons agree on which day it is. `today` is the logical
 * day (`todayKey`: Workload, stats, Start/End day) and `scheduleDay` the date the clock is on
 * (`scheduleDayKey`: anything pairing a day's blocks with the clock), with `minute` that clock's minute.
 * The two days differ between midnight and `dayEndsAt`. Never call `setDayEnd` on the server: it is
 * module state, and one user's day end would leak into the next request.
 */
export function dayFrame(settings: Partial<UserSettings>, now = new Date()) {
  const timeZone = settings.timezone ?? DEFAULT_TIMEZONE;
  const midnightDay = (iso: string) => zonedDayKey(new Date(iso), timeZone);
  return {
    timeZone,
    today: zonedDayKey(now, timeZone, settings.dayEndsAt),
    scheduleDay: zonedDayKey(now, timeZone),
    minute: zonedMinute(now, timeZone),
    at: (iso: string) => zonedDayKey(new Date(iso), timeZone, settings.dayEndsAt),
    sessionDay: (session: Pick<PomodoroSession, "dayKey" | "completedAt">) => session.dayKey ?? midnightDay(session.completedAt),
    slotDay: (session: Pick<PomodoroSession, "slotDateKey" | "completedAt">) => session.slotDateKey ?? midnightDay(session.completedAt)
  };
}

export type DayFrame = ReturnType<typeof dayFrame>;

export async function fetchDueRevisionCount(uid: string, dateKey: string): Promise<number> {
  const snapshot = await adminDb()
    .collection("users")
    .doc(uid)
    .collection("revisionItems")
    .where("suspended", "==", false)
    .where("dueDate", "<=", dateKey)
    .get();
  return snapshot.size;
}

export async function fetchDailySchedule(uid: string, dateKey: string): Promise<DailySchedule | null> {
  const snapshot = await adminDb().collection("users").doc(uid).collection("dailySchedules").doc(dateKey).get();
  return snapshot.exists ? ({ id: snapshot.id, ...snapshot.data() } as DailySchedule) : null;
}

async function fetchRevisionsCompletedCount(uid: string, dateKey: string, dayOf: (iso: string) => string): Promise<number> {
  // A day earlier than needed, because a local day can start the UTC day before; the exact day is read below.
  const snapshot = await adminDb()
    .collection("users")
    .doc(uid)
    .collection("revisionItems")
    .where("lastReviewedAt", ">=", `${addDaysToKey(dateKey, -1)}T00:00:00.000Z`)
    .get();
  return snapshot.docs.filter((doc) => dayOf(doc.data().lastReviewedAt) === dateKey).length;
}

/** users/{uid}/meta/settings — same doc the Review page reads its own maxRevisionsPerDay/maxRevisionMinutesPerDay/workMinutes from (app/(app)/review/page.tsx), so a proposed revision block is sized against this user's actual caps, not the app-wide defaults. */
async function fetchRevisionSizingSettings(uid: string): Promise<{ maxItems?: number; maxMinutes?: number; workMinutes?: number }> {
  const doc = await adminDb().collection("users").doc(uid).collection("meta").doc("settings").get();
  const data = doc.data() as { maxRevisionsPerDay?: number; maxRevisionMinutesPerDay?: number; workMinutes?: number } | undefined;
  return { maxItems: data?.maxRevisionsPerDay, maxMinutes: data?.maxRevisionMinutesPerDay, workMinutes: data?.workMinutes };
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

function dayMetrics(tasks: Task[], sessions: PomodoroSession[], dateKey: string, frame: ReturnType<typeof dayFrame>) {
  const daysSessions = sessions.filter((session) => frame.sessionDay(session) === dateKey);
  const completedTasks = tasks.filter((task) => task.completedAt && frame.at(task.completedAt) === dateKey);
  return {
    pomodoros: daysSessions.filter((session) => session.mode === "work").length,
    focusedMinutes: daysSessions.reduce((sum, session) => sum + (session.mode === "work" ? session.minutes : 0), 0),
    tasksCompleted: completedTasks.length
  };
}

/**
 * Everything a day's Load Index is computed from, assembled once (plan/19 §2.2): the day snapshot below
 * and the MCP server's `get_overview` both read Workload through this, so the two can't drift into a
 * third way of building it. (The client builds its live number in hooks/use-live-load-index.ts.)
 */
export async function loadIndexForDay(uid: string, dateKey: string, settings: Partial<UserSettings>) {
  const frame = dayFrame(settings);
  const [data, dueRevisionCount, revisionsCompletedCount, dayDoc, schedule] = await Promise.all([
    fetchInsightData(uid),
    fetchDueRevisionCount(uid, dateKey),
    fetchRevisionsCompletedCount(uid, dateKey, frame.at),
    adminDb().collection("users").doc(uid).collection("days").doc(dateKey).get(),
    fetchDailySchedule(uid, dateKey)
  ]);
  const { checkpoints, tasks, sessions, courses, goals, terms } = data;
  const day = dayDoc.data() as Day | undefined;
  const snapshot = buildLoadIndexSnapshot({
    scheduledDeepWorkMinutes: scheduleSummary(schedule?.slots ?? []).plannedDeepWork,
    revisionDueCount: dueRevisionCount,
    revisionsCompletedCount,
    checkpoints,
    courses,
    goals,
    terms,
    focusedMinutes: dayMetrics(tasks, sessions, dateKey, frame).focusedMinutes,
    todayKey: dateKey,
    isDayOff: Boolean(day?.dayOff),
    ...loadIndexScope(settings)
  });
  return { snapshot, data, day, schedule, dueRevisionCount, revisionsCompletedCount, frame };
}

/**
 * The stored record of a day: its Load Index and score, computed from what the day actually held and
 * written once, so a later edit can't change what that day was (plan/16 §5.6). Returns the Load Index.
 */
async function writeDaySnapshot(uid: string, dateKey: string, settings: Partial<UserSettings>, closing = false): Promise<number> {
  const { snapshot, data, day: dayData, schedule, frame } = await loadIndexForDay(uid, dateKey, settings);
  // plan/16 §5.6 — the day score rides along with the Load Index snapshot, written at the same
  // point and gated by the same condition, because it is the same kind of record: a historical
  // number for a day that is over. `nowMinute` is deliberately not passed, so the absolute score is
  // the honest reading, not a pace.
  const game = computeDayScore({
    slots: schedule?.slots ?? [],
    sessions: data.sessions.filter((session) => frame.slotDay(session) === dateKey),
    loadIndex: snapshot,
    isDayOff: Boolean(dayData?.dayOff)
  });
  const now = new Date().toISOString();
  await adminDb()
    .collection("users")
    .doc(uid)
    .collection("days")
    .doc(dateKey)
    .set({ loadIndex: snapshot, game: { ...game, computedAt: now }, date: dateKey, updatedAt: now, ...(closing ? { closedAt: now } : {}) }, { merge: true });
  return snapshot.value;
}

/**
 * The record of the days that have ended. The evening rollup runs at 22:00 so its suggestions arrive that
 * evening, which means its snapshot can't see anything worked afterwards. This runs after every possible
 * end of day in IST and has the last word, unless the person closed the day themselves with End day. No AI
 * call, so it costs nothing to run for everyone.
 *
 * Elsewhere a run can land before a late day end, so the night's day isn't over yet, and the next run can
 * land after one, so it's two days on. Each run closes every recent day not yet closed, oldest first.
 */
export async function closeFinishedDays(uid: string): Promise<string[]> {
  const settings = await fetchSettings(uid);
  const today = dayFrame(settings).today;
  const closed: string[] = [];
  for (let daysAgo = CLOSE_LOOKBACK_DAYS; daysAgo >= 1; daysAgo -= 1) {
    const dateKey = addDaysToKey(today, -daysAgo);
    const dayDoc = await adminDb().collection("users").doc(uid).collection("days").doc(dateKey).get();
    const day = dayDoc.data() as Day | undefined;
    if (day?.session?.endedAt || day?.closedAt) continue;
    await writeDaySnapshot(uid, dateKey, settings, true);
    closed.push(dateKey);
  }
  return closed;
}

/** Deterministic, no AI call — see lib/dailyloop.ts. Writes to days/{today}.brief. */
export async function generateMorningBrief(uid: string): Promise<MorningBrief> {
  const settings = await fetchSettings(uid);
  const today = dayFrame(settings).today;
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
    todayKey: today,
    ...loadIndexScope(settings)
  });

  // A module that's off is off here too, the same scope the target above just used.
  const brief = buildMorningBrief({
    todayKey: today,
    dueRevisionCount: isModuleEnabled(settings, "revise") ? dueRevisionCount : 0,
    checkpoints: isModuleEnabled(settings, "courses") ? checkpoints : [],
    papers,
    todaySlots: schedule?.slots ?? [],
    goals: isModuleEnabled(settings, "goals") ? goals : [],
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
  const settings = await fetchSettings(uid);
  const frame = dayFrame(settings);
  const today = frame.today;
  const yesterday = addDaysToKey(today, -1);

  const [{ checkpoints, tasks, sessions }, fetchedDueRevisionCount, dayDoc, revisionSizing] = await Promise.all([
    fetchInsightData(uid),
    fetchDueRevisionCount(uid, today),
    adminDb().collection("users").doc(uid).collection("days").doc(today).get(),
    fetchRevisionSizingSettings(uid)
  ]);
  const dueRevisionCount = isModuleEnabled(settings, "revise") ? fetchedDueRevisionCount : 0;

  const checkpointsNeedingPrep = (isModuleEnabled(settings, "courses") ? checkpoints : []).filter((c) => {
    if (!c.requiresPrep || c.status === "done" || c.status === "missed" || c.status === "submitted") return false;
    const daysUntil = Math.round((new Date(c.dueAt).getTime() - new Date(today).getTime()) / 86_400_000);
    return daysUntil >= 0 && daysUntil <= c.prepLeadDays;
  });
  const dueTasks = tasks.filter((t) => t.status !== "done" && t.dueDate && t.dueDate <= today);

  const reviewLimits = { maxItems: revisionSizing.maxItems, maxMinutes: revisionSizing.maxMinutes };
  const proposedTasks = buildProposedTasks({
    todayKey: today,
    dueTasks,
    checkpointsNeedingPrep,
    dueRevisionCount,
    reviewLimits,
    workMinutes: revisionSizing.workMinutes
  });
  const proposedSlots = buildProposedSlots({ checkpointsNeedingPrep, dueRevisionCount, reviewLimits, workMinutes: revisionSizing.workMinutes });

  const todayStats = dayMetrics(tasks, sessions, today, frame);
  const yesterdayStats = dayMetrics(tasks, sessions, yesterday, frame);

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
  const dayData = dayDoc.data() as Day | undefined;
  let loadIndexValue = dayData?.loadIndex?.value;
  if (!dayData?.session?.endedAt || loadIndexValue === undefined) {
    loadIndexValue = await writeDaySnapshot(uid, today, settings);
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
