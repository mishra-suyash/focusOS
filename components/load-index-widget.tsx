"use client";

import { InfoHint } from "@/components/info-hint";
import { loadIndexBandLabels, loadIndexBandStyles } from "@/lib/loadindex";
import type { LoadIndexSnapshot } from "@/types";

export function LoadIndexWidget({
  snapshot,
  debtHours,
  streak
}: {
  snapshot: LoadIndexSnapshot;
  /** 14-day rolling shortfall in hours (lib/loadindex.ts's computeDebtHours) — omitted callers just don't show the row. */
  debtHours?: number;
  /** Consecutive days at LI >= 0.9 (replaces the old pomodoro streak — plan §10.2). */
  streak?: number;
}) {
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1 text-base font-semibold">
          Workload
          <InfoHint term="workload" />
        </h2>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${loadIndexBandStyles[snapshot.band]}`}>
          {loadIndexBandLabels[snapshot.band]}
        </span>
      </div>
      <p className="text-3xl font-semibold leading-none">{snapshot.value.toFixed(2)}</p>
      <p className="mt-2 text-xs text-ink-500">
        {snapshot.actualMinutes}m done of {Math.max(snapshot.requiredMinutes, 30)}m required today
      </p>
      {debtHours !== undefined || streak !== undefined ? (
        <div className="mt-3 flex gap-4 border-t border-ink-100 pt-2 text-xs text-ink-500 dark:border-ink-800">
          {streak !== undefined ? (
            <span className="inline-flex items-center gap-1">
              {streak}-day streak
              <InfoHint term="onTrackStreak" />
            </span>
          ) : null}
          {debtHours !== undefined ? (
            <span className="inline-flex items-center gap-1">
              {debtHours}h catch-up (14-day)
              <InfoHint term="catchUpHours" />
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
