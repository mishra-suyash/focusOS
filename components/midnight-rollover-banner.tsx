"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { todayKey } from "@/lib/dates";

const CHECK_INTERVAL_MS = 60_000;

/**
 * F8 (plan §11.2) — every page derives "today" from `todayKey()` at render time, which only
 * re-runs when something else re-renders the component. A tab left open past midnight with no
 * interaction keeps showing yesterday's day with no visual sign anything's stale. This watches
 * the wall clock (a minute tick, plus a check whenever the tab regains visibility, which catches
 * a laptop waking up between ticks) and prompts once the date has actually moved on, rather than
 * silently reloading out from under whatever the user is doing.
 *
 * The interval alone isn't enough: browsers throttle (and can fully suspend) `setInterval` in a
 * visible-but-idle tab once the OS sleeps, so a `focus` listener backstops wake-from-sleep the
 * same way `visibilitychange` backstops switching back from another tab.
 */
export function MidnightRolloverBanner() {
  const [mountedDateKey] = useState(() => todayKey());
  const [rolledOver, setRolledOver] = useState(false);

  useEffect(() => {
    function check() {
      if (todayKey() !== mountedDateKey) setRolledOver(true);
    }
    const id = window.setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [mountedDateKey]);

  if (!rolledOver) return null;

  return (
    <div className="border-b border-moss-600/40 bg-moss-600/10 px-4 py-2 text-sm text-moss-800 dark:text-moss-200">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 shrink-0" />
          <span>New day — start it? This page is still showing yesterday.</span>
        </div>
        <button className="btn-secondary px-2 py-1 text-xs" onClick={() => window.location.reload()}>
          Refresh
        </button>
      </div>
    </div>
  );
}
