"use client";

import { orderBy } from "firebase/firestore";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useReadingPicker } from "@/components/reading-picker";
import { useReadingSitting } from "@/components/reading-sitting";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { todayKey, weekDates, weekStartKey } from "@/lib/dates";
import { DEFAULT_READING_HABIT, nextReadingPass, PASS_LABELS, readingHabitProgress, readingPickerSections, readingWeeksStreak } from "@/lib/papers";
import type { Paper, PomodoroSession, ReadingHabit, WeeklyReview } from "@/types";

/**
 * plan/17 §5.7 — Today's reading: the habit line ("2 of 4 sittings · 55 of 120 min", weeks in a row),
 * then what to read as Continue / Up next with a Start button per row, and "Read something" for the
 * picker. Replaces "Reading now", which listed papers by their raw stored status (so a paper you'd set
 * aside sat at the top) as links with no next action.
 */
export function ReadingNowCard({ papers, sessions, onBreak }: { papers: Paper[]; sessions: PomodoroSession[]; onBreak?: boolean }) {
  const { settings } = useUserSettings();
  const { openPicker } = useReadingPicker();
  const { startSitting } = useReadingSitting();
  const { items: reviews } = useUserCollection<WeeklyReview>("weeklyReviews", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const [message, setMessage] = useState("");
  const today = todayKey();
  const weekStart = weekStartKey();

  const targetFor = (start: string): ReadingHabit =>
    reviews.find((review) => review.weekStart === start)?.plan?.readingTarget ?? settings.readingHabit ?? DEFAULT_READING_HABIT;
  const target = targetFor(weekStart);
  const progress = readingHabitProgress(sessions, weekDates(weekStart), target);
  const streak = readingWeeksStreak(sessions, weekStart, targetFor);
  const sections = readingPickerSections(papers, sessions, today);
  const rows = [
    ...sections.continueReading.map((paper) => ({ paper, label: "Continue" })),
    ...sections.upNext.map((paper) => ({ paper, label: "Up next" }))
  ].slice(0, 4);

  async function start(paper: Paper) {
    setMessage("");
    const result = await startSitting({ paper, library: papers, sessions });
    if (result === "needsGoal") openPicker({ focusPaperId: paper.id });
    if (result === "busy") setMessage("A focus session is already running.");
  }

  return (
    <section className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Reading</h2>
        <Link href="/papers" className="text-xs font-medium text-moss-700 dark:text-moss-400">
          Papers
        </Link>
      </div>
      {target.sittings > 0 ? (
        <div className="mb-3">
          <p className="text-sm text-ink-600 dark:text-ink-300">
            This week: <span className="font-semibold">{Math.min(progress.sittings, target.sittings)} of {target.sittings}</span> sittings ·{" "}
            {progress.minutes} of {target.sittings * target.minutes} min
            {streak > 0 ? ` · ${streak} week${streak === 1 ? "" : "s"} in a row` : ""}
          </p>
          <div className="mt-1 flex gap-1">
            {Array.from({ length: target.sittings }, (_, i) => (
              <span key={i} className={`h-1.5 flex-1 rounded-full ${i < progress.sittings ? "bg-moss-600" : "bg-ink-100 dark:bg-ink-800"}`} />
            ))}
          </div>
        </div>
      ) : (
        <p className="mb-3 text-xs text-ink-500">No reading planned this week — a deliberate 0. Change it in weekly planning.</p>
      )}
      {onBreak ? <p className="mb-2 text-xs text-ink-500">No active semester term today — no class blocks are generated.</p> : null}
      <div className="space-y-1">
        {rows.map(({ paper, label }) => {
          const passNo = nextReadingPass(paper);
          return (
            <div key={paper.id} className="flex items-center gap-2 rounded-md bg-ink-50 px-2 py-1.5 text-sm dark:bg-ink-800">
              <Link href={`/papers/${paper.id}`} className="min-w-0 flex-1 hover:underline">
                <span className="block truncate">{paper.title}</span>
                <span className="block text-[11px] text-ink-500">
                  {label}
                  {passNo ? ` · ${PASS_LABELS[passNo]}` : ""}
                </span>
              </Link>
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => start(paper)}>
                Start
              </button>
            </div>
          );
        })}
        {rows.length === 0 ? <p className="text-sm text-ink-500">Nothing queued — &ldquo;Read something&rdquo; will help you find a paper.</p> : null}
        {sections.backFromShelf.length > 0 ? (
          <p className="text-xs text-ink-500">
            {sections.backFromShelf.length} paper{sections.backFromShelf.length === 1 ? " is" : "s are"} back from the shelf.
          </p>
        ) : null}
        {sections.inbox.length > 0 ? (
          <p className="text-xs text-ink-500">
            Inbox: {sections.inbox.length} to triage on <Link href="/papers" className="underline">Papers</Link>.
          </p>
        ) : null}
      </div>
      <button className="btn-primary mt-3 w-full py-1.5 text-xs" onClick={() => openPicker()}>
        Read something
      </button>
      {message ? <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{message}</p> : null}
    </section>
  );
}
