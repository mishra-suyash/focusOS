"use client";

import { clsx } from "clsx";
import { minutesFromTime, slotTypeStyles } from "@/lib/schedule";
import { laneLayout, MINUTES_PER_DAY } from "@/lib/timeline";
import type { PomodoroSession, ScheduleSlot } from "@/types";

type MiniStripSlot = Pick<ScheduleSlot, "type" | "startTime" | "endTime">;
type FullStripSlot = Pick<ScheduleSlot, "id" | "title" | "type" | "startTime" | "endTime">;
type DoneSession = Pick<PomodoroSession, "completedAt" | "minutes">;

export type DayStripProps =
  | { variant: "mini"; slots: MiniStripSlot[] }
  | {
      variant: "full";
      slots: FullStripSlot[];
      /** Whether this strip is showing today — the now-marker and past-dimming only make sense on today's strip. */
      isToday?: boolean;
      /** Minutes since 00:00 "now" is at — only read when `isToday`. Supplied by the caller (e.g. `useCurrentMinute()`) rather than computed here, so this stays a pure function of props. */
      nowMinute?: number;
      /** Outlines the range currently visible in a paired TimeGrid; omit to hide the brush. */
      viewportRange?: { startMinute: number; endMinute: number } | null;
      /** Click-to-navigate — "click anywhere on strip -> centre grid on that time" (§4.1). Omit to make the strip non-interactive. */
      onScrubTo?: (minute: number) => void;
      /** §4.1 "Optional lane (DP5) — a thin second lane showing actual focus sessions for the day, 'planned vs done' (S2)". Completed pomodoros for this same date; omit to render without the lane at all (fully backward compatible with every other caller of `variant="full"`). */
      sessions?: DoneSession[];
    };

const HOUR_LABELS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

/**
 * plan/FocusOS-v2-Plan-Day-Timeline.md §4.1 — "one `<DayStrip variant="full" | "mini">` powers
 * this strip, the template preview bars in Browse templates, the dashboard's full-day schedule
 * widget, and later the calendar week view." DP0 extracted `"mini"` verbatim from the template
 * gallery (unchanged rendering — proportional bar, no absolute time axis). DP1 adds `"full"`: an
 * absolute 00:00–24:00 axis with hour ticks, a now-marker, past dimming, a viewport brush, and a
 * conflict indicator for legacy overlaps (via `lib/timeline.ts`'s `laneLayout`) — everything in
 * §4.1's table except the totals row and the hover tooltip's full styling, which this renders via
 * a native `title` attribute rather than a custom popover (acceptable for a read-only DP1 view;
 * worth revisiting if DP2+ wants a richer hover state).
 */
export function DayStrip(props: DayStripProps) {
  if (props.variant === "mini") return <MiniDayStrip slots={props.slots} />;
  return <FullDayStrip {...props} />;
}

function MiniDayStrip({ slots }: { slots: MiniStripSlot[] }) {
  return (
    <div className="flex h-2.5 overflow-hidden rounded-full border border-ink-200 dark:border-ink-800" aria-hidden>
      {slots.map((slot, index) => (
        <div
          key={index}
          className={clsx("min-w-0.5 border-r border-white/70 last:border-r-0 dark:border-ink-950", slotTypeStyles[slot.type])}
          style={{ flexGrow: Math.max(1, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime)) }}
        />
      ))}
    </div>
  );
}

function pct(minutes: number): string {
  return `${Math.min(100, Math.max(0, (minutes / MINUTES_PER_DAY) * 100))}%`;
}

function FullDayStrip({ slots, isToday = false, nowMinute = 0, viewportRange, onScrubTo, sessions }: Extract<DayStripProps, { variant: "full" }>) {
  const laned = laneLayout(slots);
  const overlappingIds = new Set(laned.filter((item) => item.laneCount > 1).map((item) => item.slot.id));
  // "Actual", not "assigned" — this reads the session's own real completedAt/minutes rather than
  // whichever block its `slotId` points at, so the lane shows *when work actually happened*, which
  // can legitimately differ from when it was planned.
  const doneSegments = (sessions ?? []).map((session) => {
    const completed = new Date(session.completedAt);
    const end = completed.getHours() * 60 + completed.getMinutes();
    return { start: Math.max(0, end - session.minutes), end };
  });

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!onScrubTo) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width;
    onScrubTo(Math.round(Math.min(1, Math.max(0, ratio)) * MINUTES_PER_DAY));
  }

  return (
    <div>
      <div className="relative mb-1 h-3.5 text-[10px] text-ink-500" aria-hidden>
        {HOUR_LABELS.map((hour) => (
          <span key={hour} className={clsx("absolute -translate-x-1/2 last:-translate-x-full", hour % 6 !== 0 && "hidden sm:inline")} style={{ left: pct(hour * 60) }}>
            {String(hour).padStart(2, "0")}
          </span>
        ))}
      </div>
      <div
        className={clsx("relative h-9 overflow-hidden rounded-md border border-ink-200 bg-ink-50 dark:border-ink-800 dark:bg-ink-800 sm:h-12", onScrubTo && "cursor-pointer")}
        onClick={handleClick}
      >
        {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => (
          <div key={hour} className="pointer-events-none absolute inset-y-0 w-px bg-ink-200/70 dark:bg-ink-700/70" style={{ left: pct(hour * 60) }} />
        ))}
        {slots.map((slot) => {
          const start = minutesFromTime(slot.startTime);
          const end = minutesFromTime(slot.endTime);
          return (
            <div
              key={slot.id}
              title={`${slot.title} · ${slot.startTime}–${slot.endTime}`}
              className={clsx("absolute top-1 bottom-1 rounded border", slotTypeStyles[slot.type], overlappingIds.has(slot.id) && "ring-2 ring-red-500")}
              style={{ left: pct(start), width: `max(2px, calc(${pct(end)} - ${pct(start)}))` }}
            />
          );
        })}
        {isToday ? <div className="pointer-events-none absolute inset-y-0 left-0 bg-white/50 dark:bg-black/40" style={{ width: pct(nowMinute) }} /> : null}
        {isToday ? (
          <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-red-500" style={{ left: pct(nowMinute) }}>
            <div className="absolute -top-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rotate-45 bg-red-500" />
          </div>
        ) : null}
        {viewportRange ? (
          <div
            className="pointer-events-none absolute inset-y-0 z-10 rounded border-2 border-moss-600"
            style={{ left: pct(viewportRange.startMinute), width: `calc(${pct(viewportRange.endMinute)} - ${pct(viewportRange.startMinute)})` }}
          />
        ) : null}
      </div>
      {sessions ? (
        <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800" aria-hidden title="Actual focus sessions">
          {doneSegments.map((segment, index) => (
            <div
              key={index}
              className="absolute inset-y-0 rounded-full bg-moss-600"
              style={{ left: pct(segment.start), width: `max(2px, calc(${pct(segment.end)} - ${pct(segment.start)}))` }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
