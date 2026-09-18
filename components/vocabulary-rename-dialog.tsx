"use client";

import { X } from "lucide-react";

/** Plan §5's table, condensed to the renames most likely to be noticed — the full table also
 * lives in the README glossary for anyone who wants every row. Exported for reuse on /help
 * (plan §11.2's U6 row), so the glossary there and this one-time dialog never drift apart. */
export const RENAMES: { was: string; now: string; hint?: string }[] = [
  { was: "Load Index (LI)", now: "Workload", hint: "How much you've done today compared with what today asked for" },
  { was: "Debt", now: "Catch-up hours", hint: "Planned work you didn't get to over the last two weeks" },
  { was: "Coverage", now: "Topics revised", hint: "Share of a course's topics you've revised at least once" },
  { was: "Next Action", now: "Up next", hint: "The single most useful thing to do right now" },
  { was: "Checkpoint", now: "Assessment", hint: "A quiz, lab, assignment, presentation, or exam with a due date" },
  { was: "Topic confidence", now: "Understanding" },
  { was: "Pass 1 / Pass 2 / Pass 3", now: "Skim / Read / Deep dive", hint: "Read a paper in stages; stop whenever you have enough" },
  { was: "Reading goal", now: "Why am I reading this?" },
  { was: "Paper group / survey mode", now: "Paper set / Literature survey" },
  { was: "Slot", now: "Block", hint: "A chunk of time on your plan" },
  { was: "Workday session", now: "Your day" },
  { was: "Pomodoro", now: "Focus session" },
  { was: "Daily review", now: "Daily wrap-up" },
  { was: "Weekly review", now: "Weekly check-in" },
  { was: "Morning brief", now: "Morning overview" },
  { was: "Evening rollup", now: "Suggestions for tomorrow" },
  { was: "External task", now: "Hard deadline", hint: "Forms, visas, fees — not counted in your workload plan" }
];

/** Plan §10.2 — shown once, first load after the rename, to accounts whose onboarding already
 * resolved (existing usage or a completed/skipped first run) and haven't dismissed it yet. */
export function VocabularyRenameDialog({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16" onClick={onDismiss}>
      <div className="card w-full max-w-lg p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">We renamed a few things</h2>
          <button className="btn-secondary px-2 py-1.5" onClick={onDismiss} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-sm text-ink-600 dark:text-ink-300">
          Nothing about how FocusOS works has changed — just the words for it, to be plainer for everyone. Here&apos;s the full list:
        </p>
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {RENAMES.map((item) => (
            <div key={item.was} className="rounded-md bg-ink-50 p-2.5 text-sm dark:bg-ink-800">
              <p>
                <span className="text-ink-400 line-through">{item.was}</span>{" "}
                <span className="font-medium text-moss-700 dark:text-moss-400">→ {item.now}</span>
              </p>
              {item.hint ? <p className="mt-0.5 text-xs text-ink-500">{item.hint}</p> : null}
            </div>
          ))}
        </div>
        <button className="btn-primary mt-4 w-full" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}
