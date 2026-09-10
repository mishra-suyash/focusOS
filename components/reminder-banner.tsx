"use client";

import { Droplets, X } from "lucide-react";
import { useWorkdaySession } from "@/components/workday-session-provider";

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
          <button className="btn-secondary py-1 text-xs" onClick={acknowledgeReminder}>
            Done
          </button>
          <button className="btn-secondary px-1.5 py-1" onClick={dismissReminder} aria-label="Dismiss reminder">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
