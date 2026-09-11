"use client";

import type { ReactNode } from "react";

/**
 * Plan §9.5 — the same `<details>` disclosure `components/pomodoro-timer.tsx` already uses for
 * "Timer settings", generalized so every simplified form collapses its secondary fields behind
 * one consistent "More options" affordance instead of always showing the full field set.
 */
export function MoreOptions({ children, label = "More options" }: { children: ReactNode; label?: string }) {
  return (
    <details className="rounded-md border border-ink-200 dark:border-ink-800">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-500 outline-none focus:ring-2 focus:ring-moss-500">{label}</summary>
      <div className="space-y-3 p-3 pt-0">{children}</div>
    </details>
  );
}
