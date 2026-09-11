"use client";

import { LogIn, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { DayWrapupSheet } from "@/components/day-wrapup-sheet";
import { InfoHint } from "@/components/info-hint";
import { useFeatures } from "@/hooks/use-features";
import { useWorkdaySession } from "@/components/workday-session-provider";

const UNDO_WINDOW_MS = 10_000;

export function DaySessionBar() {
  const { active, starting, start, end, undoEnd, session } = useWorkdaySession();
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const router = useRouter();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [rollupGenerating, setRollupGenerating] = useState(false);
  const [showEndUndo, setShowEndUndo] = useState(false);
  const undoTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) window.clearTimeout(undoTimeoutRef.current);
    };
  }, []);

  async function handleEnd() {
    await end();
    // F11 (plan §11.2) — a 10-second window to undo an accidental End day instead of the old
    // "click Start day again" restart.
    setShowEndUndo(true);
    if (undoTimeoutRef.current) window.clearTimeout(undoTimeoutRef.current);
    undoTimeoutRef.current = window.setTimeout(() => setShowEndUndo(false), UNDO_WINDOW_MS);
    // Best-effort — "End day" is the plan's other trigger for the evening
    // rollup (§10.1), alongside the ~22:00 IST cron. Both the sheet below and
    // the daily review page it links to have their own "Generate" button if this fails.
    // `rollupGenerating` stays true until this settles so the sheet's own Generate button
    // can't fire a second, redundant generation while this one is still in flight.
    if (user) {
      setRollupGenerating(true);
      user
        .getIdToken()
        .then((token) => fetch("/api/daily-loop/rollup", { method: "POST", headers: { Authorization: `Bearer ${token}` } }))
        .catch(() => undefined)
        .finally(() => setRollupGenerating(false));
    }
    // Plan §9.6: packs without Weekly check-in in primary nav get an in-place sheet instead of
    // navigating away — that page isn't part of their regular flow, so a full navigation is
    // more friction than the moment calls for.
    if (isEnabled("weeklyCheckin")) {
      router.push("/reviews/daily");
    } else {
      setSheetOpen(true);
    }
  }

  async function handleUndoEnd() {
    if (undoTimeoutRef.current) window.clearTimeout(undoTimeoutRef.current);
    setShowEndUndo(false);
    setSheetOpen(false);
    await undoEnd();
  }

  return (
    <>
      {active ? (
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-ink-500 dark:text-ink-400 sm:inline">
            {session?.hydrationCount ?? 0} water · {session?.breaksTaken ?? 0} breaks
          </span>
          <button className="btn-secondary py-1.5 text-xs" onClick={handleEnd}>
            <LogOut className="h-3.5 w-3.5" />
            End day
          </button>
        </div>
      ) : (
        <span className="inline-flex items-center gap-1">
          <button className="btn-primary py-1.5 text-xs" onClick={start} disabled={starting}>
            <LogIn className="h-3.5 w-3.5" />
            {starting ? "Starting..." : "Start day"}
          </button>
          <InfoHint term="yourDay" align="right" />
        </span>
      )}
      {sheetOpen ? (
        <DayWrapupSheet
          externalGenerating={rollupGenerating}
          onClose={() => setSheetOpen(false)}
          onOpenFull={() => {
            setSheetOpen(false);
            router.push("/reviews/daily");
          }}
        />
      ) : null}
      {showEndUndo ? (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-md border border-ink-200 bg-white px-4 py-2.5 text-sm shadow-lg dark:border-ink-700 dark:bg-ink-900">
          <span>Day ended.</span>
          <button className="font-medium text-moss-700 hover:underline dark:text-moss-400" onClick={handleUndoEnd}>
            Undo
          </button>
        </div>
      ) : null}
    </>
  );
}
