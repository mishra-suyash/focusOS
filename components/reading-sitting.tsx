"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useFocusSession } from "@/components/focus-session-provider";
import { useUserSettings } from "@/hooks/use-user-settings";
import { updatePaper } from "@/lib/firestore";
import { canStartReading, DEFAULT_READING_HABIT, nextReadingPass, PASS_LABELS, sittingMinutesFor, startPassPatch } from "@/lib/papers";
import { DEFAULT_MIN_CHUNK_MINUTES } from "@/lib/timeline";
import type { Paper, PomodoroSession } from "@/types";

export type StartSittingResult = "started" | "resumed" | "needsGoal" | "busy";

/**
 * plan/17 §5.4 step 1 — starting a reading sitting is one action, wherever it's started from (the
 * Now card, a block on /plan/day, the picker, a paper's own page, the reader):
 *
 * 1. the focus timer starts, armed to the sitting's length — it is the only clock (§5.5);
 * 2. the pass the paper is owed *now* starts or resumes. Owed now, not the `passNo` frozen onto a
 *    planned block: a block planned as "Skim" for a paper you've since skimmed is a Read sitting;
 * 3. the reader opens if there's a PDF, else the paper's link opens in a new tab and its page (with
 *    the pass panel) opens here.
 *
 * Refuses rather than guesses in two cases: a Skim with no reading goal (the caller asks for one —
 * the goal gate moved from planning to here, F8), and a different focus session already running.
 */
export function useReadingSitting() {
  const { user } = useAuth();
  const router = useRouter();
  const focus = useFocusSession();
  const { settings } = useUserSettings();
  const habitMinutes = settings.readingHabit?.minutes ?? DEFAULT_READING_HABIT.minutes;
  const minChunkMinutes = settings.minChunkMinutes ?? DEFAULT_MIN_CHUNK_MINUTES;

  async function startSitting(opts: {
    paper: Paper;
    library?: Paper[];
    sessions?: PomodoroSession[];
    /** The planned block this sitting fills, so coverage and the 60% rule credit it. */
    slotId?: string;
    /** What's left of that block — wins over the computed length when given. */
    minutes?: number;
    /** Default true. False when the caller is already on the page the sitting should show. */
    navigate?: boolean;
  }): Promise<StartSittingResult> {
    const { paper } = opts;
    if (!user) return "busy";
    const navigate = opts.navigate ?? true;

    if (focus.running) {
      if (focus.paperId !== paper.id) return "busy";
      if (navigate) openPaper(paper);
      return "resumed";
    }

    const passNo = nextReadingPass(paper);
    if (passNo === 1 && !canStartReading(paper)) return "needsGoal";

    if (passNo !== null) {
      const patch = startPassPatch(paper, passNo, new Date().toISOString());
      if (patch) await updatePaper(user.uid, paper.id, patch);
    }

    const minutes =
      opts.minutes ??
      sittingMinutesFor({ paper, library: opts.library ?? [paper], sessions: opts.sessions ?? [], habitMinutes, minChunkMinutes });
    focus.startFocus({
      label: passNo ? `${PASS_LABELS[passNo]}: ${paper.title}` : `Reading: ${paper.title}`,
      category: "reading",
      slotId: opts.slotId,
      paperId: paper.id,
      ...(passNo ? { passNo } : {}),
      minutes
    });
    if (navigate) openPaper(paper);
    return "started";
  }

  function openPaper(paper: Paper) {
    if (paper.fileId) {
      router.push(`/read/${paper.id}`);
      return;
    }
    if (paper.link) window.open(paper.link, "_blank", "noopener,noreferrer");
    router.push(`/papers/${paper.id}`);
  }

  /** plan/17 §5.3 — a "Find a paper" sitting: the habit's time spent choosing what to read. */
  function startFindPaper(opts: { slotId?: string; minutes?: number } = {}) {
    if (focus.running) return "busy" as const;
    focus.startFocus({
      label: "Find a paper",
      category: "reading",
      slotId: opts.slotId,
      findPaper: true,
      minutes: opts.minutes ?? habitMinutes
    });
    return "started" as const;
  }

  return { startSitting, startFindPaper, openPaper, running: focus.running, runningPaperId: focus.paperId };
}
