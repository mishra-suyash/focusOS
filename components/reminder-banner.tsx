"use client";

import { Droplets } from "lucide-react";
import { useWorkdaySession } from "@/components/workday-session-provider";

/** F9 (plan §11.2) — "Did it" (counts toward the hydration/break counter) vs "Skip" (doesn't, just
 * pushes the next reminder out) were previously "Done" vs an icon-only ×, so the counter looked
 * buggy when it didn't move on dismiss. Explicit labels make the difference visible. */
export function ReminderBanner() {
  const { reminder, acknowledgeReminder, dismissReminder } = useWorkdaySession();

  if (!reminder) return null;

  return (
    <div className="border-b border-amberline/40 bg-amberline/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2">
          <Droplets className="h-4 w-4 shrink-0" />
          <span>{reminder.message}</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary py-1 text-xs" onClick={acknowledgeReminder}>
            Did it
          </button>
          <button className="btn-secondary py-1 text-xs" onClick={dismissReminder}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
