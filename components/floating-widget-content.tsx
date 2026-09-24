"use client";

import { format } from "date-fns";
import { Droplets, Pause, Play, X } from "lucide-react";
import { useFocusSession } from "@/components/focus-session-provider";
import { useWorkdaySession } from "@/components/workday-session-provider";
import { useCurrentMinute } from "@/hooks/use-current-minute";
import { useLiveLoadIndex } from "@/hooks/use-live-load-index";
import { useUserSettings } from "@/hooks/use-user-settings";
import { todayKey } from "@/lib/dates";
import { resolveFloatingWidgetItems } from "@/lib/floating-widget";

/**
 * The floating widget's actual content — the only component ever rendered inside the Document
 * Picture-in-Picture window (via a React portal, see `floating-widget-button.tsx`). All four items
 * from the plan doc are on by default (§3–4): the focus timer, current focus, the hydration/break
 * nudge, and today's Workload — never a generic reminders feed or motivational text (plan §3,
 * §12), but otherwise everything the plan recommends keeping, shown, not tucked behind toggles.
 */
export function FloatingWidgetContent({ onClose }: { onClose: () => void }) {
  const { settings } = useUserSettings();
  const items = resolveFloatingWidgetItems(settings);
  const { modeLabel, secondsLeft, running, progress, label, toggleRunning } = useFocusSession();
  const { reminder, acknowledgeReminder, dismissReminder } = useWorkdaySession();
  const loadIndex = useLiveLoadIndex(todayKey());
  // §10 — re-derived off the same minute-tick hook the day's "now" markers already use, so this
  // needs no interval of its own; the PiP portal shares the parent document's React tree, so the
  // hook works here unchanged.
  useCurrentMinute();
  const dayTimeLabel = format(new Date(), "EEE · HH:mm");

  const minutes = Math.floor(secondsLeft / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (secondsLeft % 60).toString().padStart(2, "0");

  return (
    <div className="relative flex h-full flex-col gap-2 overflow-y-auto bg-ink-50 p-3 text-ink-950 dark:bg-ink-950 dark:text-ink-50">
      <button
        className="absolute right-2 top-2 rounded-full bg-white/70 p-1 text-ink-500 shadow-sm transition hover:bg-white hover:text-ink-900 dark:bg-ink-800/70 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ink-50"
        onClick={onClose}
        aria-label="Close floating widget"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      {items.has("timer") ? (
        <section className="card p-3">
          <div className="flex items-center justify-between">
            <p className="label">{modeLabel}</p>
            <button className="btn-secondary px-2 py-1" onClick={toggleRunning} aria-label={running ? "Pause" : "Start"}>
              {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
            {minutes}:{seconds}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div className="h-full bg-moss-600 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </section>
      ) : null}

      {items.has("currentFocus") ? (
        <section className="card p-3 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <p className="label">{running ? "Focusing on" : "Last focus"}</p>
            <span className="text-[11px] tabular-nums text-ink-500 dark:text-ink-400">{dayTimeLabel}</span>
          </div>
          <p className="mt-0.5 truncate font-medium">{label || "No session yet"}</p>
        </section>
      ) : null}

      {/* Only the app's own sanctioned hydration/break nudge — never a generic reminders feed (plan §3, §12). Card is absent entirely, not dimmed, when nothing is due. */}
      {items.has("hydrationNudge") && reminder ? (
        <section className="card p-3 text-sm">
          <p className="flex items-center gap-1.5">
            <Droplets className="h-3.5 w-3.5 shrink-0" />
            {reminder.message}
          </p>
          <div className="mt-2 flex gap-2">
            <button className="btn-primary px-2 py-1 text-xs" onClick={acknowledgeReminder}>
              Did it
            </button>
            <button className="btn-secondary px-2 py-1 text-xs" onClick={dismissReminder}>
              Skip
            </button>
          </div>
        </section>
      ) : null}

      {items.has("loadIndex") ? (
        <section className="card p-3 text-sm">
          <p className="label">Workload</p>
          <p className="mt-0.5 text-xl font-semibold">{loadIndex.value.toFixed(2)}</p>
        </section>
      ) : null}
    </div>
  );
}
