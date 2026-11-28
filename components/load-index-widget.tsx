"use client";

import { useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { loadIndexBandLabels, loadIndexBandStyles } from "@/lib/loadindex";
import type { LoadIndexSnapshot } from "@/types";

export function LoadIndexWidget({
  snapshot,
  debtHours,
  streak,
  dayOff,
  catchUpClearedOn,
  onClearCatchUp
}: {
  snapshot: LoadIndexSnapshot;
  /** 14-day rolling shortfall in hours (lib/loadindex.ts's computeDebtHours) — omitted callers just don't show the row. */
  debtHours?: number;
  /** Consecutive days at LI >= 0.9 (replaces the old pomodoro streak — plan §10.2). */
  streak?: number;
  /** plan/15 §5.5 — today is marked off. `snapshot.requiredMinutes` is already 0 (buildLoadIndexSnapshot),
   *  but this card's usual "Xm done of Ym required" line floors the denominator to 30 for a normal
   *  light day, which would misleadingly print "0m done of 30m required" for a day nobody intended
   *  to work. Swapped for a plain note instead of trying to make the floored math read sensibly. */
  dayOff?: boolean;
  /** When catch-up hours were last cleared (yyyy-MM-dd), shown under a zero so it reads as a choice. */
  catchUpClearedOn?: string;
  /** Clears catch-up hours from today on. Omitted = no Clear control. */
  onClearCatchUp?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1 text-base font-semibold">
          Workload
          <InfoHint term="workload" />
        </h2>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${loadIndexBandStyles[snapshot.band]}`}>
          {dayOff ? "Day off" : loadIndexBandLabels[snapshot.band]}
        </span>
      </div>
      {dayOff ? (
        <p className="text-sm text-ink-500">No workload expected today.</p>
      ) : (
        <>
          <p className="text-3xl font-semibold leading-none">{snapshot.value.toFixed(2)}</p>
          <p className="mt-2 text-xs text-ink-500">
            {snapshot.actualMinutes}m done of {Math.max(snapshot.requiredMinutes, 30)}m required today
          </p>
        </>
      )}
      {debtHours !== undefined || streak !== undefined ? (
        <div className="mt-3 flex gap-4 border-t border-ink-100 pt-2 text-xs text-ink-500 dark:border-ink-800">
          {streak !== undefined ? (
            <span className="inline-flex items-center gap-1">
              {streak}-day on-track streak
              <InfoHint term="onTrackStreak" />
            </span>
          ) : null}
          {debtHours !== undefined ? (
            <span className="inline-flex flex-wrap items-center gap-1">
              {debtHours}h catch-up (14-day)
              <InfoHint term="catchUpHours" />
              {catchUpClearedOn && debtHours === 0 ? <span className="text-ink-400">· cleared {catchUpClearedOn}</span> : null}
              {onClearCatchUp && debtHours > 0 ? (
                confirming ? (
                  <>
                    <button
                      type="button"
                      className="ml-1 font-medium text-red-600 underline dark:text-red-400"
                      onClick={() => {
                        setConfirming(false);
                        onClearCatchUp();
                      }}
                    >
                      Clear {debtHours}h
                    </button>
                    <button type="button" className="underline" onClick={() => setConfirming(false)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ml-1 underline decoration-dotted"
                    title="Start catch-up hours fresh: shortfall from today and earlier stops counting. Your day records are kept, and you can undo it."
                    onClick={() => setConfirming(true)}
                  >
                    Clear
                  </button>
                )
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
