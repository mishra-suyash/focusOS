import type { Pass2Output, Paper, PaperStatus, Pass1Output, PomodoroSession } from "@/types";

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
