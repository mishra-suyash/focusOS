"use client";

import { useEffect, useState } from "react";
import { getSessionUsage, subscribeUsage } from "@/lib/usage";

/** Dev-only Firestore read/write counter, so a runaway listener is visible before it costs a day's quota. */
export function UsageOverlay() {
  const [usage, setUsage] = useState(getSessionUsage());

  useEffect(() => subscribeUsage(() => setUsage(getSessionUsage())), []);

  if (process.env.NODE_ENV !== "development") return null;

  return (
    <div className="fixed bottom-3 right-3 z-50 rounded-md border border-ink-300 bg-white/90 px-2.5 py-1.5 font-mono text-[11px] text-ink-600 shadow-soft backdrop-blur dark:border-ink-700 dark:bg-ink-900/90 dark:text-ink-300">
      reads {usage.reads} · writes {usage.writes} <span className="text-ink-400">(session)</span>
    </div>
  );
}
