import type { Pass2Output, Paper, PaperStatus, Pass1Output, PomodoroSession, Priority } from "@/types";

export const PASS_SEED_MINUTES: Record<1 | 2 | 3, number> = { 1: 7, 2: 60, 3: 90 };

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

/**
 * Status follows the passes, not a manual dropdown. A pass-1 verdict of "drop"
 * or "park" both end active reading and archive the paper — they differ only
 * in whether a 180-day resurfacing revision item gets created (see
 * lib/paperrevision.ts), not in the visible status. A paper is "read" once
 * either pass 3 is done, or pass 2 is done with a "grasped" outcome and pass 3
 * was never started (Pass 3 is opt-in, not everyone's papers need it).
 */
export function derivePaperStatus(paper: Pick<Paper, "pass1" | "pass2" | "pass3">): PaperStatus {
  const p1 = paper.pass1;
  const p2 = paper.pass2;
  const p3 = paper.pass3;
  const p1Output = p1?.output as Pass1Output | undefined;
  const p2Output = p2?.output as Pass2Output | undefined;

  if (p1?.status === "done" && (p1Output?.verdict === "drop" || p1Output?.verdict === "park")) return "archived";
  if (p3?.status === "done") return "read";
  if (p2?.status === "done" && p2Output?.outcome === "grasped" && (!p3 || p3.status === "not_started")) return "read";
  if (p1?.status === "in_progress" || p1?.status === "done" || p2?.status === "in_progress" || p3?.status === "in_progress") return "reading";
  return "to_read";
}

/** Recomputes both derived fields — call this alongside every pass update. */
export function derivePaperFields(paper: Pick<Paper, "pass1" | "pass2" | "pass3">) {
  return { progress: derivePaperProgress(paper), status: derivePaperStatus(paper) };
}

/**
 * Your own median actual duration for a pass, once you have 5+ completed
 * samples — replacing Keshav's seed estimate, per the plan: the calibration
 * only means something with your numbers, not the source's.
 */
export function calibratedPassEstimate(pastMinutes: number[], passNo: 1 | 2 | 3): number {
  if (pastMinutes.length < 5) return PASS_SEED_MINUTES[passNo];
  const sorted = [...pastMinutes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/** Share of papers that stopped at Pass 1 (dropped or parked) among papers where Pass 1 was actually completed. */
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
  to_read: "To read",
  reading: "Reading",
  read: "Read",
  archived: "Archived"
};

/**
 * plan/16 §5.2 — which pass this paper is actually owed next, or null when it is owed none.
 *
 * The weekly planner needs this because "reading" is not one undifferentiated activity in this app:
 * a pass-1 skim is minutes, a pass-2 read is an hour, and a pass-3 reimplementation is most of a
 * morning. Planning all three as one flat block was the reason reading never really joined the
 * weekly loop — see `nextPassEstimateMinutes` below for the sizing half.
 *
 * The progression follows `derivePaperStatus`'s own rules rather than inventing a second reading:
 * - A dropped or parked pass-1 verdict, or a finished paper, is owed nothing.
 * - A skipped pass counts as passed through, not as owed again.
 * - Pass 3 is **opt-in**, exactly as `derivePaperStatus` treats it: a pass 2 that ended "grasped"
 *   finishes the paper, so pass 3 is only owed when it is already under way, or when pass 2 ended
 *   "persevere" — the outcome that means the reader chose to keep going.
 */
export function nextReadingPass(paper: Pick<Paper, "pass1" | "pass2" | "pass3">): 1 | 2 | 3 | null {
  const p1 = paper.pass1;
  const p2 = paper.pass2;
  const p3 = paper.pass3;

  if (p3?.status === "done") return null;
  if (p3?.status === "in_progress") return 3;

  if (!p1 || p1.status === "not_started" || p1.status === "in_progress") return 1;
  if (p1.status === "done") {
    const verdict = (p1.output as Pass1Output | undefined)?.verdict;
    if (verdict === "drop" || verdict === "park") return null;
  }

  if (!p2 || p2.status === "not_started" || p2.status === "in_progress") return 2;
  if (p2.status === "done") {
    const outcome = (p2.output as Pass2Output | undefined)?.outcome;
    // "grasped" finishes the paper; "set-aside"/"return-later" are deliberate stops, and planning a
    // pass 3 against them would be the app arguing with a decision the reader already made.
    return outcome === "persevere" ? 3 : null;
  }
  return 3;
}

/**
 * Every completed pass of one number, in minutes, across the library — the samples
 * `calibratedPassEstimate` needs to replace Keshav's seed numbers with the reader's own medians.
 * Reads `PassState.minutes`, which `finishPass` records per pass, rather than session totals: a
 * paper's sessions can't be attributed back to a particular pass, and the whole point of the
 * calibration is per-pass.
 */
export function pastPassMinutes(papers: Pick<Paper, "pass1" | "pass2" | "pass3">[], passNo: 1 | 2 | 3): number[] {
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
export function nextPassEstimateMinutes(
  paper: Pick<Paper, "pass1" | "pass2" | "pass3">,
  library: Pick<Paper, "pass1" | "pass2" | "pass3">[]
): number {
  const passNo = nextReadingPass(paper);
  if (passNo === null) return 0;
  return calibratedPassEstimate(pastPassMinutes(library, passNo), passNo);
}

/**
 * plan/16 §5.4 — the papers weekly planning should offer, in the order it should offer them.
 *
 * Replaces the old rule, which was "papers already in `reading` status, untouched for 14+ days, top
 * three". That rule could only ever surface reading you had already started and then abandoned: a
 * paper added this week was never plannable, which is most of why reading never joined the weekly
 * loop. Staleness is now a *ranking* signal rather than the entry condition.
 *
 * Papers blocked by `canStartReading` (pass 1 needs a reading goal — the subsystem's single
 * highest-leverage field) are returned separately rather than silently dropped: proposing to read
 * one would schedule work the app then refuses to let you start, and hiding it entirely is how a
 * paper sits in the library for a month untouched.
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
    .filter((item) => !(item.passNo === 1 && !canStartReading(item.paper)))
    .map((item) => ({ ...item, minutes: nextPassEstimateMinutes(item.paper, papers), daysSinceUpdate: daysSince(item.paper) }))
    .filter((item) => item.minutes > 0)
    // Priority first (it is the field the reader set deliberately), then how long it has been
    // sitting, then the cheaper pass — so a 7-minute skim that unblocks a decision beats an hour of
    // pass 2 on something already in hand.
    .sort(
      (a, b) =>
        PAPER_PRIORITY_RANK[a.paper.priority] - PAPER_PRIORITY_RANK[b.paper.priority] ||
        b.daysSinceUpdate - a.daysSinceUpdate ||
        a.minutes - b.minutes
    )
    .slice(0, limit);

  return { plannable, needsGoal };
}

const PAPER_PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
