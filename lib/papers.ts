import type { Pass2Output, Paper, PaperStatus, Pass1Output, PomodoroSession, Priority, ReadingHabit } from "@/types";

export const PASS_SEED_MINUTES: Record<1 | 2 | 3, number> = { 1: 7, 2: 60, 3: 90 };
const MAX_HONEST_PASS_MINUTES = 6 * 60;

/**
 * Total minutes ever spent reading this paper — derived from `PomodoroSession.paperId` rather than
 * stored on the Paper doc, so it never drifts out of sync with the sessions it's summing. Counts
 * both formal pass timers (`components/paper-pass-section.tsx`'s `finishPass`, which already sets
 * `passNo`) and free reading in the full-screen window (`components/paper-reading-window.tsx`,
 * which omits `passNo`) — every session with this `paperId` was time spent on this paper either way.
 */
export function totalReadingMinutes(sessions: Pick<PomodoroSession, "paperId" | "mode" | "minutes">[], paperId: string): number {
  return sessions.filter((session) => session.paperId === paperId && session.mode === "work").reduce((sum, session) => sum + session.minutes, 0);
}

/** A paper cannot start Pass 1 without a reading goal — the single highest-leverage field in the subsystem. */
export function canStartReading(paper: Pick<Paper, "goal" | "goalKind">): boolean {
  return Boolean(paper.goal?.trim() && paper.goalKind);
}

/** 0 / 33 / 66 / 100 — never set directly, always derived from which passes are done. */
export function derivePaperProgress(paper: Pick<Paper, "pass1" | "pass2" | "pass3">): number {
  if (paper.pass3?.status === "done") return 100;
  if (paper.pass2?.status === "done") return 66;
  if (paper.pass1?.status === "done") return 33;
  return 0;
}

/** The fields `derivePaperStatus` reads — the passes plus plan/17's explicit stops. */
export type PaperStatusInput = Pick<Paper, "pass1" | "pass2" | "pass3"> & Partial<Pick<Paper, "shelvedUntil" | "droppedAt" | "inbox">>;

/** plan/17 §5.2 — default shelf time for a new shelve (§13 Q5), replacing the fixed 180-day park. */
export const DEFAULT_SHELF_DAYS = 30;
/** The 180-day resurfacing date the old "Save for later" wrote as a Revise item — kept so a legacy
 *  parked paper comes back on the same day its existing Revise item says (plan/17 §10). */
const LEGACY_PARK_DAYS = 180;

function dateKeyPlusDays(iso: string | undefined, days: number): string {
  const base = iso ? new Date(iso) : new Date();
  base.setDate(base.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
}

function isDone(pass: Paper["pass1"]): boolean {
  // A skipped pass counts as passed through, never as owed again.
  return pass?.status === "done" || pass?.status === "skipped";
}

/**
 * plan/17 §5.2 — the one status every surface agrees on, derived from the passes plus the explicit
 * stops plan/17 added. Every pass outcome maps to exactly one status:
 *
 * | Pass | Outcome | Status |
 * |---|---|---|
 * | Skim | Keep reading | reading (Read owed) |
 * | Skim | Save for later | shelved (until `shelvedUntil`) |
 * | Skim | Not relevant | dropped |
 * | Skim | Skim was enough | read |
 * | Read | Grasped it | read (Deep dive offered, not owed) |
 * | Read | Set aside / Return later | shelved |
 * | Read | Persevere | reading (Deep dive owed) |
 * | Deep dive | finished | read |
 * | any | Drop | dropped |
 *
 * Before plan/17 "Set aside" and "Return later" had no branch at all, so a paper you had decided
 * to stop stayed "Reading" forever — first in Reading now, in the morning brief, offering Deep dive.
 *
 * `shelvedUntil` is three-valued on purpose. A string is a shelf date. `null` means the paper was
 * explicitly taken back off the shelf, which is what lets a legacy parked/set-aside paper be
 * resumed. Absent means plan/17 never touched it, and the legacy derivation (§10) reads the old
 * outcome as shelved — so no backfill is needed for the status to be right everywhere.
 */
export function derivePaperStatus(paper: PaperStatusInput): PaperStatus {
  const p1 = paper.pass1;
  const p2 = paper.pass2;
  const p3 = paper.pass3;
  const verdict = (p1?.output as Pass1Output | undefined)?.verdict;
  const outcome = (p2?.output as Pass2Output | undefined)?.outcome;
  const legacyShelf = paper.shelvedUntil === undefined;

  if (paper.droppedAt) return "dropped";
  if (p1?.status === "in_progress" || p2?.status === "in_progress" || p3?.status === "in_progress") return "reading";
  if (typeof paper.shelvedUntil === "string") return "shelved";
  if (p3?.status === "done") return "read";
  if (isDone(p1) && verdict === "drop") return "dropped";
  if (isDone(p1) && verdict === "done") return "read";
  if (isDone(p2)) {
    if (outcome === "grasped") return "read";
    if ((outcome === "set-aside" || outcome === "return-later") && legacyShelf) return "shelved";
    return "reading";
  }
  if (isDone(p1)) return verdict === "park" && legacyShelf ? "shelved" : "reading";
  if (paper.inbox) return "inbox";
  return "to_read";
}

/**
 * plan/17 §5.2/§10 — the date a shelved paper comes back, or null when it isn't shelved. A legacy
 * parked paper comes back 180 days after its Skim (matching the Revise item that was created for
 * it); a legacy set-aside / return-later Read comes back on its `revisitOn`, or 30 days after.
 */
export function paperShelfDate(paper: PaperStatusInput): string | null {
  if (derivePaperStatus(paper) !== "shelved") return null;
  if (typeof paper.shelvedUntil === "string") return paper.shelvedUntil;
  const p2 = paper.pass2;
  const p2Output = p2?.output as Pass2Output | undefined;
  if (isDone(p2)) {
    if (p2Output?.outcome === "return-later" && p2Output.returnAfter?.revisitOn) return p2Output.returnAfter.revisitOn;
    return dateKeyPlusDays(p2?.completedAt, DEFAULT_SHELF_DAYS);
  }
  return dateKeyPlusDays(paper.pass1?.completedAt, LEGACY_PARK_DAYS);
}

/** True for a shelved paper whose date has come — the picker's "Back from the shelf" (§5.3). */
export function isBackFromShelf(paper: PaperStatusInput, todayKey: string): boolean {
  const date = paperShelfDate(paper);
  return date !== null && date <= todayKey;
}

/** A paper is active reading material — owed something, or in hand — rather than stopped. */
export function isActivePaper(paper: PaperStatusInput): boolean {
  const status = derivePaperStatus(paper);
  return status === "to_read" || status === "reading";
}

/** Recomputes both derived fields — call this alongside every pass or shelf/drop/queue update. */
export function derivePaperFields(paper: PaperStatusInput) {
  return { progress: derivePaperProgress(paper), status: derivePaperStatus(paper) };
}

/**
 * Your own median actual duration for a pass, once you have 5+ completed
 * samples — replacing Keshav's seed estimate, per the plan: the calibration
 * only means something with your numbers, not the source's.
 */
export function calibratedPassEstimate(pastMinutes: number[], passNo: 1 | 2 | 3): number {
  // plan/17 §10 — anything over 6 hours is a wall-clock artifact of the old pass timer (a Read left
  // open overnight), not a reading time. Dropped before counting, so one such sample can't decide
  // whether calibration kicks in either.
  const honest = pastMinutes.filter((minutes) => minutes > 0 && minutes <= MAX_HONEST_PASS_MINUTES);
  if (honest.length < 5) return PASS_SEED_MINUTES[passNo];
  const sorted = [...honest].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** Share of papers that stopped at Pass 1 (dropped or shelved) among papers where Pass 1 was actually completed. */
export function pass1DropRate(papers: Paper[]): number {
  const attempted = papers.filter((paper) => paper.pass1?.status === "done");
  if (attempted.length === 0) return 0;
  const stopped = attempted.filter((paper) => {
    const output = paper.pass1?.output as Pass1Output | undefined;
    return output?.verdict === "drop" || output?.verdict === "park";
  });
  return Math.round((stopped.length / attempted.length) * 100);
}

export const paperStatusLabels: Record<PaperStatus, string> = {
  inbox: "Inbox",
  to_read: "To read",
  reading: "Reading",
  read: "Read",
  shelved: "Shelved",
  dropped: "Dropped",
  archived: "Archived"
};

/**
 * plan/16 §5.2, revised by plan/17 §5.2 — which pass this paper is owed next, or null when it is
 * owed none.
 *
 * Reads `derivePaperStatus` first, so the two can never disagree: a shelved, dropped, finished or
 * untriaged paper is owed nothing. (Before plan/17 a set-aside Read was owed nothing here while its
 * status said "Reading", which is how it vanished from the planner but stayed in Reading now.)
 *
 * - Pass 3 is **opt-in**: it is owed only when it is already under way, or when Read ended
 *   "persevere". "Grasped it" finishes the paper.
 * - A paper taken back off the shelf owes the pass that stopped it again: Read after a set-aside or
 *   return-later, Read after a parked Skim (the Skim itself was finished).
 */
export function nextReadingPass(paper: PaperStatusInput): 1 | 2 | 3 | null {
  const status = derivePaperStatus(paper);
  if (status !== "to_read" && status !== "reading") return null;
  const p1 = paper.pass1;
  const p2 = paper.pass2;
  const p3 = paper.pass3;

  if (p3?.status === "in_progress") return 3;
  if (!isDone(p1)) return 1;
  if (!isDone(p2)) return 2;
  const outcome = (p2?.output as Pass2Output | undefined)?.outcome;
  if (outcome === "persevere") return isDone(p3) ? null : 3;
  // An unshelved set-aside / return-later Read: read it again.
  if (outcome === "set-aside" || outcome === "return-later") return 2;
  return null;
}

/**
 * plan/17 §5.5 — a pass's minutes, from the one clock: the focus sessions logged against this
 * `(paperId, passNo)`. `since` is the pass's own `startedAt`, so sessions from a cancelled earlier
 * attempt (or the previous attempt of a pass redone after the shelf) never count toward this one.
 */
export function passSessionMinutes(
  sessions: Pick<PomodoroSession, "paperId" | "passNo" | "mode" | "minutes" | "completedAt">[],
  paperId: string,
  passNo: 1 | 2 | 3,
  since?: string
): number {
  return sessions
    .filter((session) => session.mode === "work" && session.paperId === paperId && session.passNo === passNo && (!since || session.completedAt >= since))
    .reduce((sum, session) => sum + Math.max(0, session.minutes), 0);
}

/** How many focus sittings a pass has had so far — the same sessions `passSessionMinutes` sums. */
export function passSittingCount(
  sessions: Pick<PomodoroSession, "paperId" | "passNo" | "mode" | "completedAt">[],
  paperId: string,
  passNo: 1 | 2 | 3,
  since?: string
): number {
  return sessions.filter((session) => session.mode === "work" && session.paperId === paperId && session.passNo === passNo && (!since || session.completedAt >= since)).length;
}

/**
 * Every completed pass of one number, in minutes, across the library — the samples
 * `calibratedPassEstimate` needs to replace Keshav's seed numbers with the reader's own medians.
 * Reads `PassState.minutes`, which `finishPass` writes when a pass ends — since plan/17 §5.5 the sum
 * of that pass's focus sessions (`passSessionMinutes`), never wall-clock time. Older wall-clock
 * samples are still on the documents; `calibratedPassEstimate` drops anything over 6 hours.
 */
export function pastPassMinutes(papers: PaperStatusInput[], passNo: 1 | 2 | 3): number[] {
  const key = passNo === 1 ? "pass1" : passNo === 2 ? "pass2" : "pass3";
  return papers
    .map((paper) => paper[key])
    .filter((pass): pass is NonNullable<typeof pass> => pass?.status === "done" && typeof pass.minutes === "number")
    .map((pass) => pass.minutes!)
    .filter((minutes) => minutes > 0);
}

/**
 * plan/16 §5.1/§5.2 — how long to plan for this paper's next pass: the reader's own calibrated
 * estimate for that pass, not a flat guess. A 7-minute pass-1 skim stays a 7-minute block
 * (`splitIntoChunks` returns short work unchanged), which is the method working as intended rather
 * than something to pad out to a "respectable" length.
 */
export function nextPassEstimateMinutes(paper: PaperStatusInput, library: PaperStatusInput[]): number {
  const passNo = nextReadingPass(paper);
  if (passNo === null) return 0;
  return calibratedPassEstimate(pastPassMinutes(library, passNo), passNo);
}

/**
 * plan/16 §5.4, revised by plan/17 §5.3/§6.2 — the papers owed a pass, in the order a reading sitting
 * should take them: what you're already reading first (resuming beats starting), then Up next in
 * your order, then the rest by priority, staleness and the cheaper pass.
 *
 * The reading goal no longer gates *planning* (plan/17 F8): it's asked when the sitting starts, so a
 * paper without one is planned like any other. Its pass 1 just can't begin until the goal is set.
 * `needsGoal` is kept for callers that want to say so.
 */
export function readingCandidates(
  papers: Paper[],
  todayKey: string,
  limit = 4
): { plannable: { paper: Paper; passNo: 1 | 2 | 3; minutes: number; daysSinceUpdate: number }[]; needsGoal: Paper[] } {
  const daysSince = (paper: Paper) => Math.round((new Date(todayKey).getTime() - new Date(paper.updatedAt).getTime()) / 86_400_000);
  const owed = papers
    .map((paper) => ({ paper, passNo: nextReadingPass(paper) }))
    .filter((item): item is { paper: Paper; passNo: 1 | 2 | 3 } => item.passNo !== null);

  const needsGoal = owed.filter((item) => item.passNo === 1 && !canStartReading(item.paper)).map((item) => item.paper);
  const plannable = owed
    .map((item) => ({ ...item, minutes: nextPassEstimateMinutes(item.paper, papers), daysSinceUpdate: daysSince(item.paper) }))
    .filter((item) => item.minutes > 0)
    .sort((a, b) => readingOrder(a.paper, b.paper) || a.minutes - b.minutes)
    .slice(0, limit);

  return { plannable, needsGoal };
}

/**
 * The order the picker and the planner agree on: in progress, then queued (oldest `queuedAt`
 * first), then by priority — the field the reader set deliberately — then longest untouched.
 */
export function readingOrder(a: Paper, b: Paper): number {
  const rank = (paper: Paper) => (derivePaperStatus(paper) === "reading" ? 0 : paper.queuedAt ? 1 : 2);
  return (
    rank(a) - rank(b) ||
    (a.queuedAt && b.queuedAt ? (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0) : 0) ||
    PAPER_PRIORITY_RANK[a.priority] - PAPER_PRIORITY_RANK[b.priority] ||
    (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0)
  );
}

const PAPER_PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

// ---- plan/17 §5.2 — the explicit exits, as patches. Each recomputes the derived fields, so the
// stored `status` cache never disagrees with `derivePaperStatus`. ----

type PatchablePaper = PaperStatusInput & Partial<Pick<Paper, "queuedAt">>;

function withDerived<T extends Partial<Paper>>(paper: PatchablePaper, patch: T): T & { status: PaperStatus; progress: number } {
  return { ...patch, ...derivePaperFields({ ...paper, ...patch }) };
}

/** Shelve until `until` (yyyy-MM-dd). Leaves Up next and the inbox. */
export function shelvePatch(paper: PatchablePaper, until: string) {
  return withDerived(paper, { shelvedUntil: until, queuedAt: undefined, inbox: undefined } as Partial<Paper>);
}

/** Drop from any screen. Undo with `restorePatch`. */
export function dropPatch(paper: PatchablePaper, nowIso: string) {
  return withDerived(paper, { droppedAt: nowIso, queuedAt: undefined, inbox: undefined } as Partial<Paper>);
}

/** Undo a manual drop. (A Skim "Not relevant" stays dropped — that was the pass's own verdict.) */
export function restorePatch(paper: PatchablePaper) {
  return withDerived(paper, { droppedAt: undefined } as Partial<Paper>);
}

/** "Read now" / triage "Queue": off the shelf and out of the inbox, onto the end of Up next. */
export function queuePatch(paper: PatchablePaper, nowIso: string) {
  return withDerived(paper, {
    queuedAt: paper.queuedAt ?? nowIso,
    inbox: undefined,
    ...(derivePaperStatus(paper) === "shelved" ? { shelvedUntil: null } : {})
  } as Partial<Paper>);
}

/** Take out of Up next without stopping the paper. */
export function unqueuePatch(paper: PatchablePaper) {
  return withDerived(paper, { queuedAt: undefined } as Partial<Paper>);
}

/** A paper the week can plan for, or the picker can offer — the shared definition. */
export function isOwedReading(paper: PaperStatusInput): boolean {
  return nextReadingPass(paper) !== null;
}

/** plan/17 §5.1 — the reading habit when `UserSettings.readingHabit` is unset: three 30-minute
 *  sittings a week. Small enough to keep, and visible (and editable to 0) in Step 3. */
export const DEFAULT_READING_HABIT: ReadingHabit = { sittings: 3, minutes: 30 };

function passField(passNo: 1 | 2 | 3): "pass1" | "pass2" | "pass3" {
  return passNo === 1 ? "pass1" : passNo === 2 ? "pass2" : "pass3";
}

/**
 * plan/17 §5.4 step 1 — start or resume a pass. `startedAt` is set only when the pass actually
 * starts (resuming a pass in progress changes nothing). Redoing a pass that already finished — Read
 * again after the paper came back off the shelf — keeps the earlier attempt in `previousPasses`
 * rather than overwriting it, and clears the shelf marker so the redone pass's own outcome decides.
 * Returns null when there is nothing to write.
 */
export function startPassPatch(paper: Paper, passNo: 1 | 2 | 3, nowIso: string): Partial<Paper> | null {
  const key = passField(passNo);
  const current = paper[key];
  if (current?.status === "in_progress") return null;
  const previousPasses = current && current.status !== "not_started" ? [...(paper.previousPasses ?? []), { passNo, state: current }] : undefined;
  const patch: Partial<Paper> = { [key]: { status: "in_progress", startedAt: nowIso }, ...(previousPasses ? { previousPasses } : {}) };
  return { ...patch, ...derivePaperFields({ ...paper, ...patch }) };
}

/**
 * plan/17 §5.4 step 4 — cancel a pass started by mistake. Its sessions stay logged (they become
 * free reading on the paper, and `passSessionMinutes`' `since` keeps them out of a later attempt).
 * A redo is cancelled back to the attempt it replaced.
 */
export function cancelPassPatch(paper: Paper, passNo: 1 | 2 | 3): Partial<Paper> | null {
  const key = passField(passNo);
  if (paper[key]?.status !== "in_progress") return null;
  const history = paper.previousPasses ?? [];
  const lastIndex = history.map((entry) => entry.passNo).lastIndexOf(passNo);
  const patch: Partial<Paper> =
    lastIndex >= 0
      ? { [key]: history[lastIndex].state, previousPasses: history.filter((_, i) => i !== lastIndex) }
      : { [key]: { status: "not_started" } };
  return { ...patch, ...derivePaperFields({ ...paper, ...patch }) };
}

/** The pass that's running on this paper, if any. */
export function runningPass(paper: Pick<Paper, "pass1" | "pass2" | "pass3">): 1 | 2 | 3 | null {
  if (paper.pass1?.status === "in_progress") return 1;
  if (paper.pass2?.status === "in_progress") return 2;
  if (paper.pass3?.status === "in_progress") return 3;
  return null;
}

/** Plan §5 vocabulary — Pass 1 / Pass 2 / Pass 3 are Skim / Read / Deep dive everywhere a person reads them. */
export const PASS_LABELS: Record<1 | 2 | 3, string> = { 1: "Skim", 2: "Read", 3: "Deep dive" };

/**
 * plan/17 §5.4 — how long a sitting started on this paper should arm the timer for: the habit's
 * sitting length, but never longer than what's left of the pass's estimate (a 7-minute Skim arms
 * the shortest sitting, not 30 minutes), and never shorter than the shortest sitting.
 */
export function sittingMinutesFor(params: {
  paper: Paper;
  library: Paper[];
  sessions: Pick<PomodoroSession, "paperId" | "passNo" | "mode" | "minutes" | "completedAt">[];
  habitMinutes: number;
  minChunkMinutes: number;
}): number {
  const { paper, library, sessions, habitMinutes, minChunkMinutes } = params;
  const passNo = nextReadingPass(paper);
  if (passNo === null) return habitMinutes;
  const pass = paper[passField(passNo)];
  const logged = pass?.status === "in_progress" ? passSessionMinutes(sessions, paper.id, passNo, pass.startedAt) : 0;
  const left = Math.max(0, nextPassEstimateMinutes(paper, library) - logged);
  return Math.min(habitMinutes, Math.max(minChunkMinutes, left));
}

/** plan/17 §5.4 — where the reader records the page you're on, for the end-of-sitting check-in. */
export const READER_PAGE_STORAGE_PREFIX = "focusos-reader-page:";

export interface ReadingPickerSections {
  /** A pass already under way (or started and owed more), most recently read first. */
  continueReading: Paper[];
  /** Up next, in your order, then the rest of the unstarted papers by priority. */
  upNext: Paper[];
  /** Shelved papers whose date has come. */
  backFromShelf: Paper[];
  /** Captured, not yet triaged. */
  inbox: Paper[];
}

/**
 * plan/17 §5.3 — "What should I read?", in the order the picker offers it: resuming beats starting,
 * your queue beats the rest, and a shelf date that has come is surfaced rather than silently
 * re-queued. (Suggestions harvested from your reading are added by `harvestedSuggestions`.)
 */
export function readingPickerSections(papers: Paper[], sessions: Pick<PomodoroSession, "paperId" | "completedAt" | "mode">[], todayKey: string): ReadingPickerSections {
  const lastRead = new Map<string, string>();
  for (const session of sessions) {
    if (session.mode !== "work" || !session.paperId) continue;
    if ((lastRead.get(session.paperId) ?? "") < session.completedAt) lastRead.set(session.paperId, session.completedAt);
  }
  const recency = (paper: Paper) => lastRead.get(paper.id) ?? paper.updatedAt;
  const continueReading = papers
    .filter((paper) => derivePaperStatus(paper) === "reading" && nextReadingPass(paper) !== null)
    .sort((a, b) => (recency(a) < recency(b) ? 1 : recency(a) > recency(b) ? -1 : 0));
  const upNext = papers.filter((paper) => derivePaperStatus(paper) === "to_read").sort(readingOrder);
  const backFromShelf = papers
    .filter((paper) => isBackFromShelf(paper, todayKey))
    .sort((a, b) => ((paperShelfDate(a) ?? "") < (paperShelfDate(b) ?? "") ? -1 : 1));
  const inbox = papers.filter((paper) => derivePaperStatus(paper) === "inbox").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { continueReading, upNext, backFromShelf, inbox };
}

type ReadingSession = Pick<PomodoroSession, "id" | "mode" | "minutes" | "completedAt" | "paperId" | "findPaper" | "category" | "slotId">;

/** A focus session spent reading: on a paper, finding one, or a reading-category session. */
export function isReadingSession(session: Pick<PomodoroSession, "mode" | "paperId" | "findPaper" | "category">): boolean {
  return session.mode === "work" && Boolean(session.paperId || session.findPaper || session.category === "reading");
}

/**
 * plan/17 §5.7 — this week's reading against the habit: sittings and minutes, computed from sessions
 * (never stored). A sitting is a block's worth of reading — sessions inside one planned block count
 * once, a session outside any block counts on its own — and it counts when it reached 60% of the
 * habit's sitting length, the same 60% that closes a planned block (`slotAutoStatus`). "Find a paper"
 * sittings count, at most one a week (§13 Q8): showing up to choose is part of the habit, but it
 * can't replace reading.
 */
export function readingHabitProgress(
  sessions: ReadingSession[],
  weekDateKeys: string[],
  habit: Pick<ReadingHabit, "minutes">
): { sittings: number; minutes: number; findPaperSittings: number } {
  const inWeek = new Set(weekDateKeys);
  const groups = new Map<string, { minutes: number; find: boolean }>();
  let minutes = 0;
  for (const session of sessions) {
    if (!isReadingSession(session)) continue;
    const dateKey = session.completedAt.slice(0, 10);
    if (!inWeek.has(dateKey)) continue;
    minutes += Math.max(0, session.minutes);
    const key = session.slotId ? `${dateKey}|${session.slotId}` : session.id;
    const group = groups.get(key) ?? { minutes: 0, find: true };
    group.minutes += Math.max(0, session.minutes);
    group.find = group.find && Boolean(session.findPaper);
    groups.set(key, group);
  }
  const threshold = Math.max(5, Math.round(habit.minutes * 0.6));
  const counted = [...groups.values()].filter((group) => group.minutes >= threshold);
  const findPaperSittings = counted.filter((group) => group.find).length;
  const sittings = counted.filter((group) => !group.find).length + Math.min(1, findPaperSittings);
  return { sittings, minutes, findPaperSittings };
}

/**
 * plan/17 §5.7 — weeks in a row the habit was met, counting back from last week (this week joins
 * once it's met). Computed, never stored — the `computeLoadIndexStreak` rule. A week whose target
 * was 0 was a deliberate choice: it neither counts nor breaks the streak.
 */
export function readingWeeksStreak(
  sessions: ReadingSession[],
  currentWeekStart: string,
  targetForWeek: (weekStart: string) => Pick<ReadingHabit, "sittings" | "minutes">,
  maxWeeks = 52
): number {
  const weekKeys = (start: string) => Array.from({ length: 7 }, (_, i) => dateKeyPlusDays(`${start}T12:00:00`, i));
  let streak = 0;
  const current = targetForWeek(currentWeekStart);
  if (current.sittings > 0 && readingHabitProgress(sessions, weekKeys(currentWeekStart), current).sittings >= current.sittings) streak += 1;
  let start = dateKeyPlusDays(`${currentWeekStart}T12:00:00`, -7);
  for (let i = 0; i < maxWeeks; i += 1) {
    const target = targetForWeek(start);
    if (target.sittings > 0) {
      if (readingHabitProgress(sessions, weekKeys(start), target).sittings < target.sittings) break;
      streak += 1;
    }
    start = dateKeyPlusDays(`${start}T12:00:00`, -7);
  }
  return streak;
}

/**
 * plan/17 §6.5 — when this paper last changed status (a pass finishing, a drop), for Look back's
 * "papers moved this week". Falls back to `updatedAt` for a shelve or drop made off-pass.
 */
export function lastStatusChangeAt(paper: Paper): string {
  const stamps = [paper.droppedAt, paper.pass1?.completedAt, paper.pass2?.completedAt, paper.pass3?.completedAt].filter((stamp): stamp is string => Boolean(stamp));
  if (typeof paper.shelvedUntil === "string" && !stamps.length) return paper.updatedAt;
  return stamps.sort().at(-1) ?? paper.updatedAt;
}
