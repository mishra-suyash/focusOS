"use client";

import { useEffect, useState } from "react";

/**
 * A wall-clock elapsed-time display anchored to a persisted `startedAt` —
 * deliberately not a local start/pause stopwatch, so that refreshing mid-pass
 * shows the correct elapsed time instead of resetting to zero (the pass's
 * `startedAt` lives on the Paper doc in Firestore, not in component state).
 */
export function PassTimer({ startedAt, seedMinutes }: { startedAt: string; seedMinutes: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;

  return (
    <div className="flex items-center gap-3 rounded-md bg-ink-50 px-3 py-2 dark:bg-ink-800">
      <span className="font-mono text-sm tabular-nums">
        {minutes}:{seconds.toString().padStart(2, "0")}
      </span>
      <span className="text-xs text-ink-500">seed estimate: {seedMinutes}m</span>
    </div>
  );
}

export function elapsedMinutesSince(startedAt: string): number {
  return Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000));
}
