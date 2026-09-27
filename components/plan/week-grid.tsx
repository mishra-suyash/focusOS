"use client";

import { useRef, useState } from "react";
import { clsx } from "clsx";
import { getDay, parseISO } from "date-fns";
import { Lock } from "lucide-react";
import { TypedTimeInput } from "@/components/plan/typed-time-input";
import { minutesFromTime, minutesToTime, slotTypeStyles } from "@/lib/schedule";
import { magnetize, minutesToPx, pxToMinutes, snapMinutes } from "@/lib/timeline";
import type { ProposalDecision, ScheduleSlot } from "@/types";
import type { WeekProposal, WorkingWindow } from "@/lib/weekplan";

/**
 * plan/16 §5.3 — the week you can actually plan on.
 *
 * Step 4 used to be an accept/dismiss list of text rows at whatever times `placeProposals` chose,
 * with no way to say "not there, here" short of dismissing a proposal and hand-building a block on
 * `/plan/day` (§2.3). This is the grid: days across, the working window down, proposed sittings
 * draggable between any free position on any working day.
 *
 * Deliberately *not* a second `TimeGrid`. That component owns a single day and does create, resize,
 * ripple, lane layout and long-press arming against real saved slots; this one moves proposals that
 * aren't saved anywhere yet, and moving is the only gesture it has. What the two share is the pure
 * geometry in `lib/timeline.ts` (`minutesToPx`/`pxToMinutes`/`snapMinutes`/`magnetize`), so a
 * dragged position here is always one `placeInWindow`'s own 15-minute search step could have
 * produced, and the one thing added is a horizontal hit test mapping x to a date key.
 *
 * Three rules this surface holds itself to:
 *
 * 1. **Nothing is written until Accept.** A drag updates local state and this grid's capacity
 *    readout, nothing else. `WeekPlan.proposedBlocks` is a Firestore array field — a `merge: true`
 *    write replaces it wholesale — so per-drag persistence would rewrite the whole array on every
 *    pointer-up. Accept was already the commit point and stays it.
 * 2. **Invalid drops refuse rather than correct.** Overlapping a lecture, leaving the working
 *    window, or landing on a day off just doesn't commit — the same "policy A" `TimeGrid` uses, so
 *    a refused drag reads as never having moved rather than as a silent relocation.
 * 3. **Every drag has a non-drag equivalent** (WCAG 2.5.7), and it is not a lesser path: the
 *    `ProposalInspector` rows the caller renders beside this grid do the same job with a day
 *    `<select>`, a typed start time and a duration field. The grid is the enhancement; that list is
 *    the floor, and it is also what narrow screens get, where seven columns don't fit.
 */

const PX_PER_HOUR = 44;
const SNAP_MINUTES = 15;

export interface WeekGridPlacement {
  dateKey: string;
  startMinutes: number;
  durationMinutes: number;
}

type Gesture = {
  pointerId: number;
  key: string;
  durationMinutes: number;
  /** Minutes between the proposal's own start and where the pointer grabbed it, so a block dragged
   *  by its middle doesn't jump its top edge to the cursor. */
  grabOffsetMinutes: number;
};

type Preview = { key: string; dateKey: string; startMinutes: number; durationMinutes: number; valid: boolean };

function overlaps(startMinutes: number, endMinutes: number, ranges: { startTime: string; endTime: string }[]): boolean {
  // A plain range check rather than `rangeOverlapsSlots` — that helper's `excludeId` compares
  // `slot.id !== excludeId`, which treats every slot as excluded when both are undefined, and the
  // synthetic ranges built here have no ids. Same reason `placeInWindow` avoids it.
  return ranges.some((range) => startMinutes < minutesFromTime(range.endTime) && minutesFromTime(range.startTime) < endMinutes);
}

export function WeekGrid({
  weekDateKeys,
  dayLabels,
  workingWindow,
  offDateKeys,
  fixedSlotsByDate,
  proposals,
  decisions,
  onPlace,
  onAccept,
  disabled = false,
  chipFor,
  dayScoreFor,
  announce
}: {
  weekDateKeys: string[];
  dayLabels: string[];
  workingWindow: WorkingWindow;
  offDateKeys: ReadonlySet<string>;
  /** What the week already genuinely contains — lectures, routine, the weekly-planning anchor,
   *  external calendar events, anything already saved. Drawn locked; never movable here (plan/16
   *  §5.4 / assumption A1: these are fixed reality, and this grid is for placing chosen work). */
  fixedSlotsByDate: Record<string, ScheduleSlot[]>;
  /** Only proposals that currently have a position. A proposal that didn't fit has no place on a
   *  grid; it appears in the caller's inspector list with a day and time to choose instead. */
  proposals: WeekProposal[];
  decisions: Record<string, ProposalDecision>;
  onPlace: (key: string, placement: WeekGridPlacement) => void;
  onAccept: (key: string) => void;
  disabled?: boolean;
  /** `describeObjective`-derived chip text — passed in rather than derived here so this component
   *  needs none of the course/paper/checkpoint context (plan/16 §5.2's one-function rule). */
  chipFor?: (proposal: WeekProposal) => string | null;
  /** plan/16 §5.6 — a past day's score, for the per-column readout. Null/absent renders nothing. */
  dayScoreFor?: (dateKey: string) => number | null | undefined;
  announce?: (message: string) => void;
}) {
  const columnsRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  // The grid spans whole hours around the working window, so the hour labels line up with the rows.
  const gridStart = Math.floor(minutesFromTime(workingWindow.startTime) / 60) * 60;
  const gridEnd = Math.ceil(minutesFromTime(workingWindow.endTime) / 60) * 60;
  const windowStart = minutesFromTime(workingWindow.startTime);
  const windowEnd = minutesFromTime(workingWindow.endTime);
  const gridHeight = minutesToPx(gridEnd - gridStart, PX_PER_HOUR);
  const hours = Array.from({ length: Math.max(1, (gridEnd - gridStart) / 60) }, (_, i) => gridStart / 60 + i);

  const undecided = proposals.filter((p) => !decisions[p.key]);
  const proposalsByDate = new Map<string, WeekProposal[]>();
  for (const p of undecided) {
    if (!proposalsByDate.has(p.dateKey)) proposalsByDate.set(p.dateKey, []);
    proposalsByDate.get(p.dateKey)!.push(p);
  }

  function durationOf(p: WeekProposal): number {
    return Math.max(SNAP_MINUTES, minutesFromTime(p.endTime) - minutesFromTime(p.startTime));
  }

  /** Everything a proposal may not overlap on `dateKey`: the locked layer, plus every other
   *  undecided proposal (its own current position excluded — a block may always stay where it is). */
  function blockersFor(dateKey: string, exceptKey: string): { startTime: string; endTime: string }[] {
    return [
      ...(fixedSlotsByDate[dateKey] ?? []).map((slot) => ({ startTime: slot.startTime, endTime: slot.endTime })),
      ...(proposalsByDate.get(dateKey) ?? []).filter((p) => p.key !== exceptKey).map((p) => ({ startTime: p.startTime, endTime: p.endTime }))
    ];
  }

  function validAt(dateKey: string, startMinutes: number, durationMinutes: number, exceptKey: string): boolean {
    if (offDateKeys.has(dateKey)) return false;
    if (!workingWindow.daysOfWeek.includes(getDay(parseISO(dateKey)))) return false;
    if (startMinutes < windowStart || startMinutes + durationMinutes > windowEnd) return false;
    return !overlaps(startMinutes, startMinutes + durationMinutes, blockersFor(dateKey, exceptKey));
  }

  /** The pointer's position as a (date, start-minute) pair, snapped and magnetized to the edges of
   *  whatever is already on the day it's over. */
  function hitTest(clientX: number, clientY: number, gesture: Gesture): { dateKey: string; startMinutes: number } | null {
    const el = columnsRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const columnWidth = rect.width / weekDateKeys.length;
    const columnIndex = Math.min(weekDateKeys.length - 1, Math.max(0, Math.floor((clientX - rect.left) / columnWidth)));
    const dateKey = weekDateKeys[columnIndex];
    const rawMinute = gridStart + pxToMinutes(clientY - rect.top, PX_PER_HOUR) - gesture.grabOffsetMinutes;
    const neighbourEdges = blockersFor(dateKey, gesture.key).flatMap((range) => [
      minutesFromTime(range.startTime),
      minutesFromTime(range.endTime),
      // The *end* edge matters too: dragging a block to sit flush above a lecture means matching
      // its own end to that lecture's start, which is this start minus its duration.
      minutesFromTime(range.startTime) - gesture.durationMinutes
    ]);
    const startMinutes = Math.max(windowStart, magnetize(rawMinute, [...neighbourEdges, windowStart, windowEnd - gesture.durationMinutes], SNAP_MINUTES));
    return { dateKey, startMinutes: snapMinutes(startMinutes, 1) };
  }

  function beginDrag(event: React.PointerEvent, proposal: WeekProposal) {
    if (disabled) return;
    const el = columnsRef.current;
    if (!el) return;
    const duration = durationOf(proposal);
    const pointerMinute = gridStart + pxToMinutes(event.clientY - el.getBoundingClientRect().top, PX_PER_HOUR);
    gestureRef.current = {
      pointerId: event.pointerId,
      key: proposal.key,
      durationMinutes: duration,
      grabOffsetMinutes: Math.max(0, Math.min(duration, pointerMinute - minutesFromTime(proposal.startTime)))
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview({ key: proposal.key, dateKey: proposal.dateKey, startMinutes: minutesFromTime(proposal.startTime), durationMinutes: duration, valid: true });
  }

  function handleMove(event: React.PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const hit = hitTest(event.clientX, event.clientY, gesture);
    if (!hit) return;
    setPreview({
      key: gesture.key,
      dateKey: hit.dateKey,
      startMinutes: hit.startMinutes,
      durationMinutes: gesture.durationMinutes,
      valid: validAt(hit.dateKey, hit.startMinutes, gesture.durationMinutes, gesture.key)
    });
  }

  function handleEnd(event: React.PointerEvent) {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const hit = hitTest(event.clientX, event.clientY, gesture);
    setPreview(null);
    if (!hit) return;
    if (!validAt(hit.dateKey, hit.startMinutes, gesture.durationMinutes, gesture.key)) {
      announce?.(`Can't move there — ${offDateKeys.has(hit.dateKey) ? "that day is marked off" : "something is already in that space"}.`);
      return;
    }
    onPlace(gesture.key, { dateKey: hit.dateKey, startMinutes: hit.startMinutes, durationMinutes: gesture.durationMinutes });
    announce?.(`Moved to ${hit.dateKey} at ${minutesToTime(hit.startMinutes)}.`);
  }

  /** Free minutes left inside the working window on one day, after the locked layer and every
   *  proposal still sitting there. Recomputed every render, so it follows a drag live (§5.3). */
  function freeMinutesOn(dateKey: string): number {
    if (offDateKeys.has(dateKey)) return 0;
    const taken = [...(fixedSlotsByDate[dateKey] ?? []), ...(proposalsByDate.get(dateKey) ?? [])].reduce((sum, item) => {
      const start = Math.max(windowStart, minutesFromTime(item.startTime));
      const end = Math.min(windowEnd, minutesFromTime(item.endTime));
      return sum + Math.max(0, end - start);
    }, 0);
    return Math.max(0, windowEnd - windowStart - taken);
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-[52rem] gap-1">
        <div className="w-10 shrink-0 pt-12">
          {hours.map((hour) => (
            <div key={hour} className="relative text-right text-[10px] tabular-nums text-ink-400" style={{ height: PX_PER_HOUR }}>
              <span className="absolute -top-1.5 right-1">{String(hour).padStart(2, "0")}</span>
            </div>
          ))}
        </div>

        <div className="flex-1">
          <div className="flex gap-1">
            {weekDateKeys.map((dateKey, index) => {
              const score = dayScoreFor?.(dateKey);
              return (
                <div key={dateKey} className="min-w-0 flex-1 pb-1 text-center">
                  <p className={clsx("text-xs font-medium", offDateKeys.has(dateKey) && "text-ink-400 line-through")}>
                    {dayLabels[index]} {dateKey.slice(5)}
                  </p>
                  <p className="text-[10px] tabular-nums text-ink-400">
                    {offDateKeys.has(dateKey) ? "Day off" : `${Math.round(freeMinutesOn(dateKey) / 6) / 10}h free`}
                    {typeof score === "number" ? ` · ${score}` : ""}
                  </p>
                </div>
              );
            })}
          </div>

          <div ref={columnsRef} className="relative flex gap-1" style={{ height: gridHeight }}>
            {weekDateKeys.map((dateKey) => {
              const isOff = offDateKeys.has(dateKey);
              const isWorkingDay = workingWindow.daysOfWeek.includes(getDay(parseISO(dateKey)));
              return (
                <div
                  key={dateKey}
                  className={clsx(
                    "relative min-w-0 flex-1 rounded-md border",
                    isOff || !isWorkingDay ? "border-ink-200 bg-ink-100/60 dark:border-ink-800 dark:bg-ink-900/60" : "border-ink-200 dark:border-ink-800"
                  )}
                >
                  {hours.slice(1).map((hour) => (
                    <div
                      key={hour}
                      className="absolute inset-x-0 border-t border-ink-100 dark:border-ink-800/60"
                      style={{ top: minutesToPx(hour * 60 - gridStart, PX_PER_HOUR) }}
                    />
                  ))}

                  {/* The locked layer: what the week genuinely already contains. */}
                  {(fixedSlotsByDate[dateKey] ?? [])
                    .filter((slot) => minutesFromTime(slot.endTime) > gridStart && minutesFromTime(slot.startTime) < gridEnd)
                    .map((slot) => {
                      const start = Math.max(gridStart, minutesFromTime(slot.startTime));
                      const end = Math.min(gridEnd, minutesFromTime(slot.endTime));
                      return (
                        <div
                          key={slot.id}
                          className="absolute inset-x-0.5 overflow-hidden rounded bg-ink-200/70 px-1 py-0.5 text-[10px] leading-tight text-ink-600 dark:bg-ink-800/80 dark:text-ink-300"
                          style={{ top: minutesToPx(start - gridStart, PX_PER_HOUR), height: Math.max(8, minutesToPx(end - start, PX_PER_HOUR)) }}
                          title={`${slot.title} · ${slot.startTime}–${slot.endTime}`}
                        >
                          <span className="flex items-center gap-0.5 truncate">
                            <Lock className="h-2.5 w-2.5 shrink-0" />
                            {slot.title}
                          </span>
                        </div>
                      );
                    })}

                  {/* The movable layer. */}
                  {(proposalsByDate.get(dateKey) ?? []).map((proposal) => {
                    const dragging = preview?.key === proposal.key;
                    // While dragging, the block follows the pointer — including into another column,
                    // where this instance simply isn't rendered and the shadow below is.
                    if (dragging && preview!.dateKey !== dateKey) return null;
                    const start = dragging ? preview!.startMinutes : minutesFromTime(proposal.startTime);
                    const duration = dragging ? preview!.durationMinutes : durationOf(proposal);
                    const chip = chipFor?.(proposal);
                    return (
                      <div
                        key={proposal.key}
                        role="button"
                        tabIndex={-1}
                        aria-label={`${proposal.title}, ${proposal.startTime} to ${proposal.endTime}. Drag to move, or use the list below.`}
                        onPointerDown={(event) => beginDrag(event, proposal)}
                        onPointerMove={handleMove}
                        onPointerUp={handleEnd}
                        onPointerCancel={() => {
                          gestureRef.current = null;
                          setPreview(null);
                        }}
                        onDoubleClick={() => !disabled && onAccept(proposal.key)}
                        className={clsx(
                          "absolute inset-x-0.5 touch-none overflow-hidden rounded border px-1 py-0.5 text-[10px] leading-tight",
                          slotTypeStyles[proposal.type],
                          dragging && !preview!.valid && "opacity-40 ring-2 ring-red-500",
                          dragging && preview!.valid && "ring-2 ring-moss-500",
                          disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing"
                        )}
                        style={{ top: minutesToPx(start - gridStart, PX_PER_HOUR), height: Math.max(10, minutesToPx(duration, PX_PER_HOUR)) }}
                        title={`${proposal.title} · ${chip ?? ""}`}
                      >
                        <span className="block truncate font-medium">{proposal.title}</span>
                        {chip && duration >= 30 ? <span className="block truncate opacity-75">{chip}</span> : null}
                      </div>
                    );
                  })}

                  {/* The drop shadow, only while the dragged block is over a column it doesn't
                      currently belong to — otherwise the block itself already shows the position. */}
                  {preview && preview.dateKey === dateKey && !(proposalsByDate.get(dateKey) ?? []).some((p) => p.key === preview.key) ? (
                    <div
                      className={clsx(
                        "pointer-events-none absolute inset-x-0.5 rounded border-2 border-dashed",
                        preview.valid ? "border-moss-500 bg-moss-500/10" : "border-red-500 bg-red-500/10"
                      )}
                      style={{
                        top: minutesToPx(preview.startMinutes - gridStart, PX_PER_HOUR),
                        height: Math.max(10, minutesToPx(preview.durationMinutes, PX_PER_HOUR))
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * plan/16 §5.3 — the mandatory non-drag equivalent, and the narrow-screen floor.
 *
 * Every move the grid above supports by pointer is completable here by keyboard alone: Tab to the
 * row, pick a day, type a start time, set a duration, Accept. This is the same standard
 * `components/plan/plan-tray.tsx` already holds itself to (WCAG 2.5.7) — there, every draggable
 * thing has a button doing the same job — and it is deliberately the *primary* rendering rather
 * than a hidden fallback, because it is also the only way to place a proposal the placement search
 * couldn't fit anywhere: such a proposal has no position, so it cannot appear on a grid at all,
 * and before this it could only be dismissed.
 */
export function ProposalInspector({
  proposal,
  weekDateKeys,
  dayLabels,
  offDateKeys,
  decision,
  onPlace,
  onAccept,
  onDismiss,
  disabled = false,
  chip,
  invalidReason,
  suggestStart
}: {
  proposal: WeekProposal;
  weekDateKeys: string[];
  dayLabels: string[];
  offDateKeys: ReadonlySet<string>;
  decision?: ProposalDecision;
  onPlace: (key: string, placement: WeekGridPlacement) => void;
  onAccept: (key: string) => void;
  onDismiss: (key: string) => void;
  disabled?: boolean;
  chip?: string | null;
  /** A start minute that would actually work on `dateKey` — the caller knows what that day already
   *  contains, so it decides. Used when a proposal has no position yet: such a proposal carries
   *  `startTime: "00:00"`, so picking a day without this would place it at midnight and greet the
   *  user with "outside your working window" on the one path that exists for placing work the
   *  search refused. */
  suggestStart?: (dateKey: string, durationMinutes: number) => number;
  /** Why this proposal can't be accepted where it currently sits, if it can't — the caller knows
   *  about the locked layer and the other proposals, so it decides; this only renders the sentence. */
  invalidReason?: string | null;
}) {
  const duration = Math.max(5, minutesFromTime(proposal.endTime) - minutesFromTime(proposal.startTime));
  const placed = proposal.fits || Boolean(proposal.startTime && proposal.startTime !== "00:00");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-ink-50 px-3 py-2 text-xs dark:bg-ink-800">
      <span className="min-w-40 flex-1 truncate">
        {proposal.title}
        {chip ? <span className="ml-1 text-ink-500">· {chip}</span> : null}
      </span>
      <select
        className="input w-28 py-1 text-xs"
        aria-label={`Day for ${proposal.title}`}
        value={placed ? proposal.dateKey : ""}
        disabled={disabled}
        onChange={(event) =>
          onPlace(proposal.key, {
            dateKey: event.target.value,
            startMinutes: placed ? minutesFromTime(proposal.startTime) : suggestStart?.(event.target.value, duration) ?? minutesFromTime(proposal.startTime),
            durationMinutes: duration
          })
        }
      >
        {!placed ? <option value="">Pick a day</option> : null}
        {weekDateKeys.map((dateKey, index) => (
          <option key={dateKey} value={dateKey} disabled={offDateKeys.has(dateKey)}>
            {dayLabels[index]} {dateKey.slice(5)}
            {offDateKeys.has(dateKey) ? " (off)" : ""}
          </option>
        ))}
      </select>
      <TypedTimeInput
        className="input w-20 py-1 text-xs"
        value={placed ? proposal.startTime : ""}
        disabled={disabled || !placed}
        onChange={(time) => onPlace(proposal.key, { dateKey: proposal.dateKey, startMinutes: minutesFromTime(time), durationMinutes: duration })}
      />
      <label className="flex items-center gap-1">
        <input
          className="input w-16 py-1 text-xs"
          type="number"
          min={5}
          step={5}
          aria-label={`Minutes for ${proposal.title}`}
          value={duration}
          disabled={disabled}
          onChange={(event) =>
            onPlace(proposal.key, {
              dateKey: proposal.dateKey,
              startMinutes: minutesFromTime(proposal.startTime),
              durationMinutes: Math.max(5, Number(event.target.value))
            })
          }
        />
        <span className="text-ink-500">min</span>
      </label>
      {decision ? (
        <span className="text-ink-500">{decision}</span>
      ) : (
        <>
          <button
            className="btn-secondary px-2 py-1"
            onClick={() => onAccept(proposal.key)}
            disabled={disabled || !placed || Boolean(invalidReason)}
            title={invalidReason ?? undefined}
          >
            Accept
          </button>
          <button className="btn-secondary px-2 py-1" onClick={() => onDismiss(proposal.key)} disabled={disabled}>
            Dismiss
          </button>
        </>
      )}
      {invalidReason ? <span className="w-full text-[11px] text-red-600 dark:text-red-400">{invalidReason}</span> : null}
    </div>
  );
}
