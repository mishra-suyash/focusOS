"use client";

import { Info, X } from "lucide-react";
import Link from "next/link";
import { useWorkdaySession } from "@/components/workday-session-provider";

/** F1/F3's one-time notice — shown after Start day used a built-in fallback template and/or
 *  skipped template blocks that overlapped a class (plan §6.1, §11.2), or plan/14 §7.3's S5 "no
 *  weekly plan" prompt, which additionally carries `startDayLink` — a one-click way to fix it. */
export function StartDayNoticeBanner() {
  const { startDayNotice, startDayLink, dismissStartDayNotice } = useWorkdaySession();

  if (!startDayNotice) return null;

  return (
    <div className="border-b border-sky-500/40 bg-sky-500/10 px-4 py-2 text-sm text-sky-800 dark:text-sky-200">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 shrink-0" />
          <span>{startDayNotice}</span>
          {startDayLink ? (
            <Link href={startDayLink.href} className="font-medium underline">
              {startDayLink.label}
            </Link>
          ) : null}
        </div>
        <button className="btn-secondary px-1.5 py-1" onClick={dismissStartDayNotice} aria-label="Dismiss notice">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
