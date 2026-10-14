"use client";

import { clsx } from "clsx";
import { BookOpen } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { ReadingGoalChips } from "@/components/reading-goal-chips";
import { useReadingSitting } from "@/components/reading-sitting";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { updatePaper } from "@/lib/firestore";
import {
  DEFAULT_SHELF_DAYS,
  derivePaperStatus,
  dropPatch,
  isBackFromShelf,
  nextReadingPass,
  PASS_LABELS,
  paperShelfDate,
  queuePatch,
  restorePatch,
  runningPass,
  shelvePatch,
  unqueuePatch
} from "@/lib/papers";
import type { Paper, PomodoroSession } from "@/types";

/**
 * plan/17 §5.2 — every way to move a paper between statuses, in one bar at the top of its page, so
 * stopping a paper never depends on reaching the end of a pass form. Read (start a sitting) is the
 * primary button; Up next, Shelve and Drop are always one tap away; a shelved paper offers Read now;
 * a paper dropped by hand can be restored.
 */
export function PaperStatusActions({
  paper,
  library,
  sessions,
  hasFile,
  className
}: {
  paper: Paper;
  library: Paper[];
  sessions: PomodoroSession[];
  hasFile: boolean;
  className?: string;
}) {
  const { user } = useAuth();
  const { startSitting, running, runningPaperId } = useReadingSitting();
  const [shelving, setShelving] = useState(false);
  const [shelfDate, setShelfDate] = useState(addDaysToKey(todayKey(), DEFAULT_SHELF_DAYS));
  const [message, setMessage] = useState("");
  const status = derivePaperStatus(paper);
  const owed = nextReadingPass(paper);
  const inPass = runningPass(paper);
  const nowIso = () => new Date().toISOString();

  async function patch(next: Partial<Paper>) {
    if (user) await updatePaper(user.uid, paper.id, next);
  }

  async function read() {
    setMessage("");
    const result = await startSitting({ paper, library, sessions });
    if (result === "busy") setMessage("Another focus session is in progress — finish it first.");
    if (result === "needsGoal") setMessage("needsGoal");
  }

  const sittingHere = running && runningPaperId === paper.id;
  const primaryLabel = sittingHere ? "Back to the sitting" : owed ? (inPass ? `Continue ${PASS_LABELS[owed]}` : `Start ${PASS_LABELS[owed]}`) : null;

  return (
    <section className={clsx("card p-4", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {status === "inbox" ? (
          <>
            <span className="text-sm text-ink-600 dark:text-ink-300">In your inbox — not looked at yet.</span>
            <button className="btn-primary py-1.5 text-xs" onClick={() => patch(queuePatch(paper, nowIso()))}>
              Queue in Up next
            </button>
          </>
        ) : null}
        {(status === "to_read" || status === "reading") && primaryLabel ? (
          <button className="btn-primary py-1.5 text-xs" onClick={read}>
            {primaryLabel}
          </button>
        ) : null}
        {status === "to_read" || status === "reading" ? (
          paper.queuedAt ? (
            <button className="btn-secondary py-1.5 text-xs" onClick={() => patch(unqueuePatch(paper))}>
              In Up next · remove
            </button>
          ) : (
            <button className="btn-secondary py-1.5 text-xs" onClick={() => patch(queuePatch(paper, nowIso()))}>
              Add to Up next
            </button>
          )
        ) : null}
        {status === "shelved" ? (
          <>
            <span className="text-sm text-ink-600 dark:text-ink-300">
              {isBackFromShelf(paper, todayKey()) ? "Back from the shelf today." : `On the shelf until ${paperShelfDate(paper)}.`}
            </span>
            <button className="btn-primary py-1.5 text-xs" onClick={() => patch(queuePatch(paper, nowIso()))}>
              Read now
            </button>
          </>
        ) : null}
        {status === "dropped" ? (
          <>
            <span className="text-sm text-ink-600 dark:text-ink-300">Dropped.</span>
            {paper.droppedAt ? (
              <button className="btn-secondary py-1.5 text-xs" onClick={() => patch(restorePatch(paper))}>
                Restore
              </button>
            ) : null}
          </>
        ) : null}
        {status === "read" ? <span className="text-sm text-ink-600 dark:text-ink-300">Finished.</span> : null}
        {hasFile ? (
          <Link href={`/read/${paper.id}`} className="btn-secondary py-1.5 text-xs">
            <BookOpen className="h-3.5 w-3.5" />
            Open reader
          </Link>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {status !== "dropped" && status !== "read" && !inPass ? (
            shelving ? (
              <>
                <input className="input w-36 py-1 text-xs" type="date" value={shelfDate} min={todayKey()} onChange={(e) => setShelfDate(e.target.value)} aria-label="Shelve until" />
                <button
                  className="btn-secondary py-1.5 text-xs"
                  onClick={async () => {
                    await patch(shelvePatch(paper, shelfDate));
                    setShelving(false);
                  }}
                >
                  Shelve
                </button>
                <button className="px-1 text-xs text-ink-500 underline" onClick={() => setShelving(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn-secondary py-1.5 text-xs" onClick={() => setShelving(true)}>
                {status === "shelved" ? "Change date" : "Shelve…"}
              </button>
            )
          ) : null}
          {status !== "dropped" && !inPass ? (
            <button className="btn-secondary py-1.5 text-xs text-red-600" onClick={() => patch(dropPatch(paper, nowIso()))}>
              Drop
            </button>
          ) : null}
        </span>
      </div>
      {inPass ? (
        <p className="mt-2 text-xs text-ink-500">
          {PASS_LABELS[inPass]} is in progress — finish it below (its ending decides what happens next), or cancel it there to shelve or drop.
        </p>
      ) : null}
      {message === "needsGoal" ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-500">Why are you reading this? Pick one and the Skim starts.</p>
          <ReadingGoalChips
            paper={paper}
            onPicked={(goalKind, goal) => {
              setMessage("");
              void startSitting({ paper: { ...paper, goal, goalKind }, library, sessions });
            }}
          />
        </div>
      ) : message ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{message}</p>
      ) : null}
    </section>
  );
}
