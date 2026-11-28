"use client";

import Link from "next/link";
import { useState } from "react";
import { DEADLINE_ALERT_DAYS, type UnplannedDeadline } from "@/lib/deadlines";

/**
 * Hard deadlines coming up with no time blocked for them (`unplannedHardDeadlines`). External tasks
 * are outside Workload, so nothing else on the dashboard pushes for them. "Schedule a sitting" places
 * the first sitting in today's next free gap, the same way Up next's "Schedule it" does.
 */
export function DeadlineBanner({ deadlines, onSchedule }: { deadlines: UnplannedDeadline[]; onSchedule: (taskId: string) => Promise<boolean> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [noRoom, setNoRoom] = useState<string | null>(null);
  if (deadlines.length === 0) return null;
  return (
    <section className="card border-amber-300 p-4 dark:border-amber-800" aria-label="Hard deadlines with nothing planned">
      <p className="label mb-2">Hard deadlines with no time blocked · next {DEADLINE_ALERT_DAYS} days</p>
      <ul className="space-y-2">
        {deadlines.map(({ task, daysLeft }) => (
          <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium">{task.title}</span>{" "}
              <span className="text-xs text-amber-700 dark:text-amber-400">
                {daysLeft === 0 ? "due today" : `due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`} ({task.dueDate})
                {task.estimatedPomodoros ? ` · about ${task.estimatedPomodoros} session${task.estimatedPomodoros === 1 ? "" : "s"}` : ""}
              </span>
              {noRoom === task.id ? <span className="ml-2 text-xs text-ink-500">No free gap left today. Plan it in the week instead.</span> : null}
            </span>
            <span className="flex gap-2">
              <button
                className="btn-secondary py-1 text-xs"
                disabled={busy === task.id}
                onClick={async () => {
                  setBusy(task.id);
                  try {
                    if (!(await onSchedule(task.id))) setNoRoom(task.id);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Schedule a sitting today
              </button>
              <Link href="/plan/week" className="btn-secondary py-1 text-xs">
                Plan the week
              </Link>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
