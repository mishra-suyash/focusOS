"use client";

import { format } from "date-fns";
import { ArrowRight, Droplets, Pause, Play, X } from "lucide-react";
import { useFocusSession } from "@/components/focus-session-provider";
import { useWorkdaySession } from "@/components/workday-session-provider";
import { useCurrentMinute } from "@/hooks/use-current-minute";
import { useDayReadout } from "@/hooks/use-day-readout";
import { useFeatures } from "@/hooks/use-features";
import { useLiveLoadIndex } from "@/hooks/use-live-load-index";
import { useNextAction } from "@/hooks/use-next-action";
import { useUserSettings } from "@/hooks/use-user-settings";
import { todayKey } from "@/lib/dates";
import { resolveFloatingWidgetItems } from "@/lib/floating-widget";
import { formatDayReadout } from "@/lib/gamify";

/**
 * The floating widget's actual content — the only component ever rendered inside the Document
 * Picture-in-Picture window (via a React portal, see `floating-widget-button.tsx`). Plan/08's own
 * four items are on by default (§3–4): the focus timer, current focus, the hydration/break nudge,
 * and today's Workload — never a generic reminders feed (plan/08 §3, §12), which remains banned:
 * this is a fixed list of named cards and nothing is pinnable.
 *
 * plan/16 §5.7 adds two more, and states plainly where it narrows plan/08's charter. `nextAction`
 * renders `pickNextAction`'s existing cascade — one line and one button, the single next thing, not
 * a feed — and its button arms a correctly-sized, correctly-attributed session straight from the
 * block (§5.5), so the PiP is single-tap actionable in the way plan/08 asked every card to be.
 * `dayScore` is a number and a progress bar, exactly the shape of the `loadIndex` card that already
 * ships. Motivational *text* stays banned — no praise strings, no streak-loss warnings; a motivating
 * *number* derived from real logged data is permitted, on plan/08's own "a number, not prose" test.
 */
export function FloatingWidgetContent({ onClose }: { onClose: () => void }) {
  const { settings } = useUserSettings();
  const items = resolveFloatingWidgetItems(settings);
  const { modeLabel, secondsLeft, running, progress, label, toggleRunning, startFocus } = useFocusSession();
  const { isEnabled } = useFeatures();
  const today = todayKey();
  const { action: nextAction, startArgs } = useNextAction(today);
  const dayReadout = useDayReadout(today);
  const { reminder, acknowledgeReminder, dismissReminder } = useWorkdaySession();
  const loadIndex = useLiveLoadIndex(today);
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

      {items.has("nextAction") && nextAction ? (
        <section className="card p-3 text-sm">
          <p className="label">Next</p>
          <p className="mt-0.5 truncate font-medium">{nextAction.title}</p>
          <p className="truncate text-[11px] text-ink-500 dark:text-ink-400">{nextAction.why}</p>
          {startArgs && !running ? (
            <button className="btn-primary mt-2 w-full px-2 py-1 text-xs" onClick={() => startFocus(startArgs)}>
              Start{startArgs.minutes ? ` ${startArgs.minutes}m` : ""}
              <ArrowRight className="ml-1 inline h-3 w-3" />
            </button>
          ) : null}
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

      {/* Gated on the module as well as the widget item, so turning Day score off on
          /settings/features removes it here too rather than leaving one orphaned surface. */}
      {items.has("dayScore") && isEnabled("dayScore") && dayReadout.sittingsPlanned > 0 ? (
        <section className="card p-3 text-sm">
          <p className="label">{dayReadout.mode === "pace" ? "Today's pace" : "Today's score"}</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums">
            {dayReadout.mode === "pace"
              ? dayReadout.pace == null
                ? "—"
                : `${Math.round(dayReadout.pace * 100)}%`
              : dayReadout.score == null
                ? "—"
                : dayReadout.score}
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div
              className="h-full bg-moss-600 transition-all"
              style={{
                width: `${Math.min(100, dayReadout.mode === "pace" ? (dayReadout.pace ?? 0) * 100 : dayReadout.score ?? 0)}%`
              }}
            />
          </div>
          <p className="mt-1 truncate text-[11px] text-ink-500 dark:text-ink-400">{formatDayReadout(dayReadout)}</p>
        </section>
      ) : null}
    </div>
  );
}
