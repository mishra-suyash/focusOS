"use client";

import { LogIn, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useWorkdaySession } from "@/components/workday-session-provider";

export function DaySessionBar() {
  const { active, starting, start, end, session } = useWorkdaySession();
  const { user } = useAuth();
  const router = useRouter();

  async function handleEnd() {
    await end();
    // Best-effort — "End day" is the plan's other trigger for the evening
    // rollup (§10.1), alongside the ~22:00 IST cron. The daily review page
    // the user lands on next has its own "Generate" button if this fails.
    if (user) {
      user
        .getIdToken()
        .then((token) => fetch("/api/daily-loop/rollup", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))
        .catch(() => undefined);
    }
    router.push("/reviews/daily");
  }

  if (active) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden text-xs text-ink-500 dark:text-ink-400 sm:inline">
          {session?.hydrationCount ?? 0} water · {session?.breaksTaken ?? 0} breaks
        </span>
        <button className="btn-secondary py-1.5 text-xs" onClick={handleEnd}>
          <LogOut className="h-3.5 w-3.5" />
          End day
        </button>
      </div>
    );
  }

  return (
    <button className="btn-primary py-1.5 text-xs" onClick={start} disabled={starting}>
      <LogIn className="h-3.5 w-3.5" />
      {starting ? "Starting..." : "Start day"}
    </button>
  );
}
