"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { clsx } from "clsx";
import { Check, Lock, X } from "lucide-react";
import { computeSlotStatus, createSlot, isLockedSlot, minutesFromTime, minutesToTime, slotTypeIcons, slotTypeLabels, slotTypeStyles } from "@/lib/schedule";
import { clampToDay, laneLayout, magnetize, minutesToPx, MINUTES_PER_DAY, nearestFreeGap, pxToMinutes, rangeOverlapsSlots, rippleMove } from "@/lib/timeline";
import type { ScheduleSlot, ScheduleSlotType } from "@/types";

const STATUS_WORDS: Record<ReturnType<typeof computeSlotStatus>, string> = {
  upcoming: "Upcoming",
  active: "Now",
  completed: "Past",
  skipped: "Skipped"
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** DP3 tray drops (task/quick-block) that land outside any existing container's own gesture — rendered by `TimeGrid` on the tray's behalf since the tray's pointer capture lives on its own element, not inside the grid. */
export type ExternalPreview =
  | { kind: "single"; start: number; end: number; valid: boolean; label: string }
  | { kind: "template"; blocks: { start: number; end: number; type: ScheduleSlotType; title: string }[] };

export interface TimeGridHandle {
  /** Centres the grid's scroll on `minute` — the day strip's "click anywhere -> centre grid on that time" (§4.1) drives this. Honors `prefers-reduced-motion` regardless of the requested `behavior` (§9). */
  scrollToMinute: (minute: number, behavior?: ScrollBehavior) => void;
  /** DP3 — given a pointer's *viewport* coordinates (from a drag that started in `PlanTray`), returns the minute at that point and which slot (if any) is visually under it, or `null` if the point isn't over the grid's visible content at all. */
  hitTest: (clientX: number, clientY: number) => { minute: number; slotId: string | null } | null;
  /** DP3 — shows (or clears, with `null`) a tray-driven ghost inside the grid while a cross-container drag is in progress. */
  setExternalPreview: (preview: ExternalPreview | null) => void;
  /** DP4 §9 "after delete, focus moves to the next block in time" — moves DOM focus to a rendered block by id, a no-op if it isn't currently rendered. */
  focusSlot: (id: string) => void;
}

const PX_PER_HOUR = 64;
const GRID_HEIGHT = minutesToPx(MINUTES_PER_DAY, PX_PER_HOUR);
const GUTTER_WIDTH = 48;
const HOURS = Array.from({ length: 25 }, (_, hour) => hour);
const MIN_DURATION_MINUTES = 15;
const CREATE_THRESHOLD_PX = 6;
/** §5's touch column, DP4 — a still finger for this long holds before create/move arms as a drag; a shorter hold or any real movement before then is left to the browser as an ordinary scroll (see the touch-vs-scroll note on `contentRef`'s `touch-pan-y` below). Mouse/pen keep DP2's instant-arm — there's no scroll ambiguity to resolve for them. */
const LONG_PRESS_MOVE_MS = 250;
const LONG_PRESS_CREATE_MS = 400;

type PointerGesture =
  | { kind: "create"; pointerId: number; startClientY: number; anchorMinute: number; moved: boolean }
  | { kind: "move"; pointerId: number; id: string; duration: number; grabOffsetMinutes: number }
  | { kind: "resize"; pointerId: number; id: string; edge: "start" | "end"; original: { start: number; end: number } };

type DragPreview = {
  kind: "create" | "move" | "resize";
  id?: string;
  start: number;
  end: number;
  valid: boolean;
  /** §5.1 option B, DP3 — while invalid, "would fit at HH:MM" computed from `nearestFreeGap`; absent if nothing fits anywhere. */
  hintStart?: number;
  /** DP3 Shift-drag ripple — set only when holding Shift resolved a valid cascade (see `rippleMove`); the full next `slots` array to commit on drop, and also used to redraw every pushed block at its new position while the gesture is live. */
  rippleResult?: ScheduleSlot[];
};

/**
 * plan/05.FocusOS-v2-Plan-Day-Timeline.md §4.2/§5, DP2 — create/move/resize by drag, snap (15min) +
 * edge magnetism, overlap policy A (refuse: invalid drops just don't commit, no state ever
 * changes to reflect them — "snapping back" is really "never having moved"). Legacy overlaps
 * still lane-lay-out via `lib/timeline.ts`'s `laneLayout` (DP1, unchanged).
 *
 * Never verified with an actual pointer/touchscreen (no device in this session) — the underlying
 * math (`magnetize`, `rangeOverlapsSlots`, snap) is unit-tested in `verify-timeline.ts`, but the
 * gesture wiring itself (pointer capture, threshold-to-start-a-create-drag, handle hit areas) is
 * not. §10's "CSS transform only during drag, commit to state on drop" is also not followed
 * precisely — this uses React state for the live drag preview for implementation simplicity,
 * which is correct but not necessarily smooth; that's a tuning question for whenever this is
 * actually tried on a device, not a correctness one.
 *
 * D2, extended by the Routine-Blocks spec: any locked slot (`isLockedSlot`, lib/schedule.ts — a
 * class block or a materialized routine block) doesn't start a move/resize gesture —
 * `BlockInspector` carries an "Edit course schedule"/"Edit in Settings" link instead.
 */
export const TimeGrid = forwardRef<
  TimeGridHandle,
  {
    slots: ScheduleSlot[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    /** Called once per finished gesture with the full next `slots` array — never during the gesture itself (DP2's "zero writes during drag": nothing here calls this from a pointermove handler). */
    onCommit: (slots: ScheduleSlot[]) => void;
    isToday: boolean;
    nowMinute: number;
    initialScrollMinute: number;
    onViewportChange?: (range: { startMinute: number; endMinute: number }) => void;
    /** §9 "live region" announcements (DP4) — a completed/refused gesture's result as a sentence for `DayTimelineEditor`'s `aria-live` region. Optional so this stays testable/usable without one. */
    announce?: (message: string) => void;
    /** DP5 S3 — undecided "Suggestions for tomorrow" ghosts to render directly in the grid, each keyed by its index into that rollup's `proposedSlots` (matches `slotDecisions`' own keys). */
    suggestions?: { key: string; title: string; type: ScheduleSlotType; start: number; end: number }[];
    onAcceptSuggestion?: (key: string) => void;
    onDismissSuggestion?: (key: string) => void;
  }
>(function TimeGrid(
  { slots, selectedId, onSelect, onCommit, isToday, nowMinute, initialScrollMinute, onViewportChange, announce, suggestions, onAcceptSuggestion, onDismissSuggestion },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const longPressTimeoutRef = useRef<number | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [externalPreview, setExternalPreview] = useState<ExternalPreview | null>(null);
  const laned = laneLayout(slots);
  const ripplePositions = preview?.rippleResult
    ? new Map(preview.rippleResult.map((slot) => [slot.id, { start: minutesFromTime(slot.startTime), end: minutesFromTime(slot.endTime) }]))
    : null;

  useImperativeHandle(ref, () => ({
    scrollToMinute(minute, behavior = "smooth") {
      const el = containerRef.current;
      if (!el) return;
      el.scrollTo({ top: Math.max(0, minutesToPx(minute, PX_PER_HOUR) - el.clientHeight / 2), behavior: prefersReducedMotion() ? "auto" : behavior });
    },
    hitTest(clientX, clientY) {
      const containerEl = containerRef.current;
      const contentEl = contentRef.current;
      if (!containerEl || !contentEl) return null;
      const containerRect = containerEl.getBoundingClientRect();
      if (clientX < containerRect.left || clientX > containerRect.right || clientY < containerRect.top || clientY > containerRect.bottom) return null;
      const minute = clampToDay(pxToMinutes(clientY - contentEl.getBoundingClientRect().top, PX_PER_HOUR));
      const hitEl = document.elementFromPoint(clientX, clientY);
      const slotId = hitEl instanceof HTMLElement ? hitEl.closest<HTMLElement>("[data-slot-id]")?.dataset.slotId ?? null : null;
      return { minute, slotId };
    },
    setExternalPreview,
    focusSlot(id) {
      containerRef.current?.querySelector<HTMLElement>(`[data-slot-id="${id}"]`)?.focus();
    }
  }));

  function reportViewport() {
    const el = containerRef.current;
    if (!el || !onViewportChange) return;
    onViewportChange({
      startMinute: pxToMinutes(el.scrollTop, PX_PER_HOUR),
      endMinute: pxToMinutes(el.scrollTop + el.clientHeight, PX_PER_HOUR)
    });
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: Math.max(0, minutesToPx(initialScrollMinute, PX_PER_HOUR) - 40), behavior: "auto" });
    reportViewport();
  }, []);

  function minuteFromClientY(clientY: number): number {
    const el = contentRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return pxToMinutes(clientY - rect.top, PX_PER_HOUR);
  }

  function edgesExcluding(id?: string): number[] {
    const edges: number[] = [];
    for (const slot of slots) {
      if (slot.id === id) continue;
      edges.push(minutesFromTime(slot.startTime), minutesFromTime(slot.endTime));
    }
    return edges;
  }

  function clearLongPress() {
    if (longPressTimeoutRef.current) {
      window.clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  }

  function cancelGesture() {
    clearLongPress();
    gestureRef.current = null;
    setPreview(null);
  }

  function handleBackgroundPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startClientY = event.clientY;
    const anchorMinute = minuteFromClientY(event.clientY);
    const arm = () => {
      gestureRef.current = { kind: "create", pointerId, startClientY, anchorMinute, moved: false };
      target.setPointerCapture(pointerId);
    };
    // §5 touch column — a still 400ms hold arms the gesture; a real scroll swipe claims the pointer
    // first (via `touch-pan-y` below) and fires `pointercancel`, which `cancelGesture` already clears
    // this same timer for. Mouse/pen have no scroll ambiguity, so they arm immediately as in DP2.
    if (event.pointerType === "touch") {
      clearLongPress();
      longPressTimeoutRef.current = window.setTimeout(arm, LONG_PRESS_CREATE_MS);
    } else {
      arm();
    }
  }

  function handleBlockPointerDown(event: React.PointerEvent<HTMLDivElement>, slot: ScheduleSlot) {
    event.stopPropagation();
    if (isLockedSlot(slot)) return; // D2 — locked; BlockInspector links to editing the course/routine settings instead.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    onSelect(slot.id); // "Tap block" selects immediately regardless of input — only the *move* gesture itself waits out the long-press below.
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const start = minutesFromTime(slot.startTime);
    const end = minutesFromTime(slot.endTime);
    const grabOffsetMinutes = minuteFromClientY(event.clientY) - start;
    const arm = () => {
      gestureRef.current = { kind: "move", pointerId, id: slot.id, duration: end - start, grabOffsetMinutes };
      target.setPointerCapture(pointerId);
    };
    if (event.pointerType === "touch") {
      clearLongPress();
      longPressTimeoutRef.current = window.setTimeout(arm, LONG_PRESS_MOVE_MS);
    } else {
      arm();
    }
  }

  function handleHandlePointerDown(event: React.PointerEvent<HTMLDivElement>, slot: ScheduleSlot, edge: "start" | "end") {
    event.stopPropagation();
    if (isLockedSlot(slot)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // No long-press here — a resize handle is already a small, dedicated, only-visible-when-selected
    // target (§5 touch column lists no delay for it), so there's no scroll gesture to disambiguate from.
    gestureRef.current = {
      kind: "resize",
      pointerId: event.pointerId,
      id: slot.id,
      edge,
      original: { start: minutesFromTime(slot.startTime), end: minutesFromTime(slot.endTime) }
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const minute = minuteFromClientY(event.clientY);

    if (gesture.kind === "create") {
      if (!gesture.moved && Math.abs(event.clientY - gesture.startClientY) < CREATE_THRESHOLD_PX) return;
      gesture.moved = true;
      const rawStart = Math.min(gesture.anchorMinute, minute);
      const rawEnd = Math.max(gesture.anchorMinute, minute);
      const edges = edgesExcluding();
      const start = magnetize(rawStart, edges);
      const end = Math.max(start + MIN_DURATION_MINUTES, magnetize(rawEnd, edges));
      const valid = !rangeOverlapsSlots(start, end, slots);
      setPreview({ kind: "create", start, end, valid, hintStart: valid ? undefined : (nearestFreeGap(slots, start, end - start) ?? undefined) });
      return;
    }

    if (gesture.kind === "move") {
      const edges = edgesExcluding(gesture.id);
      const rawStart = minute - gesture.grabOffsetMinutes;
      const magnetized = magnetize(rawStart, edges);
      const start = Math.min(Math.max(0, magnetized), MINUTES_PER_DAY - gesture.duration);
      const end = start + gesture.duration;
      const valid = !rangeOverlapsSlots(start, end, slots, gesture.id);
      if (!valid && event.shiftKey) {
        const rippled = rippleMove(slots, gesture.id, start, end);
        if (rippled) {
          setPreview({ kind: "move", id: gesture.id, start, end, valid: true, rippleResult: rippled });
          return;
        }
      }
      setPreview({ kind: "move", id: gesture.id, start, end, valid, hintStart: valid ? undefined : (nearestFreeGap(slots, start, gesture.duration, 15, gesture.id) ?? undefined) });
      return;
    }

    if (gesture.kind === "resize") {
      const edges = edgesExcluding(gesture.id);
      if (gesture.edge === "end") {
        const end = Math.max(gesture.original.start + MIN_DURATION_MINUTES, magnetize(minute, edges));
        const valid = !rangeOverlapsSlots(gesture.original.start, end, slots, gesture.id);
        setPreview({
          kind: "resize",
          id: gesture.id,
          start: gesture.original.start,
          end,
          valid,
          hintStart: valid ? undefined : (nearestFreeGap(slots, gesture.original.start, end - gesture.original.start, 15, gesture.id) ?? undefined)
        });
      } else {
        const start = Math.min(gesture.original.end - MIN_DURATION_MINUTES, magnetize(minute, edges));
        const clampedStart = Math.max(0, start);
        const valid = !rangeOverlapsSlots(clampedStart, gesture.original.end, slots, gesture.id);
        setPreview({
          kind: "resize",
          id: gesture.id,
          start: clampedStart,
          end: gesture.original.end,
          valid,
          hintStart: valid ? undefined : (nearestFreeGap(slots, clampedStart, gesture.original.end - clampedStart, 15, gesture.id) ?? undefined)
        });
      }
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    // A quick tap released before its long-press timer fired never armed `gestureRef` — clear the
    // pending timer regardless, or it would fire `setPointerCapture` on a pointer that's already up.
    clearLongPress();
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    gestureRef.current = null;
    const finished = preview;
    setPreview(null);
    if (!finished) return; // no movement past the create-threshold — nothing to commit or announce

    if (!finished.valid) {
      // Invalid drop — never touched `slots`, so there's nothing to revert, only to explain (§9's
      // live-region example: "Cannot drop, overlaps Lunch").
      const overlap = slots.find(
        (slot) => slot.id !== finished.id && minutesFromTime(slot.startTime) < finished.end && finished.start < minutesFromTime(slot.endTime)
      );
      announce?.(overlap ? `Cannot drop, overlaps ${overlap.title}.` : "Cannot drop there.");
      return;
    }

    if (finished.kind === "create") {
      const next = createSlot({ startTime: minutesToTime(finished.start), endTime: minutesToTime(finished.end) });
      onCommit([...slots, next]);
      onSelect(next.id);
      announce?.(`Block created, ${minutesToTime(finished.start)} to ${minutesToTime(finished.end)}.`);
    } else if (finished.rippleResult) {
      onCommit(finished.rippleResult);
      const moved = slots.find((slot) => slot.id === finished.id);
      announce?.(`${moved?.title ?? "Block"} moved to ${minutesToTime(finished.start)} to ${minutesToTime(finished.end)}, later blocks shifted to make room.`);
    } else {
      onCommit(slots.map((slot) => (slot.id === finished.id ? { ...slot, startTime: minutesToTime(finished.start), endTime: minutesToTime(finished.end) } : slot)));
      const changed = slots.find((slot) => slot.id === finished.id);
      const verb = finished.kind === "move" ? "moved" : "resized";
      announce?.(`${changed?.title ?? "Block"} ${verb} to ${minutesToTime(finished.start)} to ${minutesToTime(finished.end)}.`);
    }
  }

  return (
    <div
      ref={containerRef}
      className="h-[32rem] overflow-y-auto rounded-md border border-ink-200 dark:border-ink-800"
      onScroll={reportViewport}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancelGesture();
      }}
    >
      <div className="relative flex" style={{ height: GRID_HEIGHT }}>
        <div className="relative shrink-0 border-r border-ink-200 dark:border-ink-800" style={{ width: GUTTER_WIDTH }}>
          {HOURS.map((hour) => (
            <span key={hour} className="absolute -translate-y-1/2 pl-1 text-[10px] text-ink-400" style={{ top: minutesToPx(hour * 60, PX_PER_HOUR) }}>
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        <div
          ref={contentRef}
          // `touch-pan-y` (not `touch-none`) — DP4: a plain swipe must still scroll the page/grid
          // natively. Only once a long-press timer actually arms a gesture does `setPointerCapture`
          // take over that specific pointer (per the Pointer Events spec, capture suppresses the
          // browser's own touch handling for it from then on); until then, touch-action governs and
          // lets an in-progress scroll claim the pointer, which fires `pointercancel` here.
          className="relative flex-1 touch-pan-y"
          onPointerDown={handleBackgroundPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelGesture}
        >
          {HOURS.map((hour) => (
            <div key={hour} className="pointer-events-none absolute inset-x-0 border-t border-ink-200/70 dark:border-ink-800/70" style={{ top: minutesToPx(hour * 60, PX_PER_HOUR) }} />
          ))}
          {isToday ? (
            <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: minutesToPx(nowMinute, PX_PER_HOUR) }} />
          ) : null}
          {slots.length === 0 ? (
            <p className="pointer-events-none p-4 text-sm text-ink-500">Drag on the grid to add a block, or pick a template.</p>
          ) : null}
          {laned.map(({ slot, lane, laneCount }) => {
            const isBeingDragged = (preview?.kind === "move" || preview?.kind === "resize") && preview.id === slot.id;
            const pushedTo = !isBeingDragged ? ripplePositions?.get(slot.id) : undefined;
            const isBeingPushed = pushedTo != null;
            const start = isBeingDragged ? preview.start : pushedTo ? pushedTo.start : minutesFromTime(slot.startTime);
            const end = isBeingDragged ? preview.end : pushedTo ? pushedTo.end : minutesFromTime(slot.endTime);
            const widthPct = 100 / laneCount;
            const isSelected = selectedId === slot.id;
            const TypeIcon = slotTypeIcons[slot.type];
            const status = slot.status === "skipped" || slot.status === "completed" ? slot.status : isToday ? computeSlotStatus(slot, nowMinute) : "upcoming";
            const taskCount = slot.assignedTaskIds?.length ?? 0;
            // §9 semantics — "Reading, 18:30 to 19:15, upcoming, 1 task": every block is a
            // focusable button whose label carries type/time/status/task-count, not just color.
            const ariaLabel = `${slot.title}, ${slotTypeLabels[slot.type]}, ${minutesToTime(start)} to ${minutesToTime(end)}, ${STATUS_WORDS[status]}${
              taskCount > 0 ? `, ${taskCount} task${taskCount > 1 ? "s" : ""}` : ""
            }`;
            return (
              <div
                key={slot.id}
                data-slot-id={slot.id}
                role="button"
                tabIndex={0}
                aria-label={ariaLabel}
                aria-pressed={isSelected}
                onPointerDown={(event) => handleBlockPointerDown(event, slot)}
                onClick={() => onSelect(slot.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelect(slot.id);
                }}
                className={clsx(
                  "absolute cursor-grab rounded border px-2 py-1 text-left text-xs leading-tight outline-none focus-visible:ring-2 focus-visible:ring-moss-500",
                  // Selected blocks skip clipping — a short (< ~30min) block's own 24px-tall resize
                  // handles (WCAG 2.5.8) would otherwise get clipped down to the block's own tiny
                  // height by `overflow-hidden`, shrinking their real hit area right when a resize
                  // is most likely (a block actively selected for editing).
                  !isSelected && "overflow-hidden",
                  slotTypeStyles[slot.type],
                  isSelected && "ring-2 ring-moss-600",
                  laneCount > 1 && "ring-1 ring-red-500",
                  isBeingDragged && (preview!.valid ? "opacity-80" : "opacity-60 ring-2 ring-red-500"),
                  isBeingPushed && "opacity-70 ring-1 ring-amber-500"
                )}
                style={{
                  top: minutesToPx(start, PX_PER_HOUR),
                  height: Math.max(14, minutesToPx(end - start, PX_PER_HOUR)),
                  left: `${lane * widthPct}%`,
                  width: `${widthPct}%`
                }}
              >
                <span className="flex items-center gap-1 truncate font-medium">
                  <TypeIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {isLockedSlot(slot) ? <Lock className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
                  <span className="truncate">{slot.title}</span>
                  {taskCount > 0 ? (
                    <span className="ml-auto shrink-0 rounded-full bg-black/10 px-1 text-[10px] font-normal dark:bg-white/10">{taskCount}</span>
                  ) : null}
                </span>
                <span className="block truncate opacity-80">
                  {minutesToTime(start)}–{minutesToTime(end)} · {STATUS_WORDS[status]}
                </span>
                {isBeingDragged && !preview!.valid && preview!.hintStart != null ? (
                  <span className="block truncate font-medium text-red-700 dark:text-red-300">Free at {minutesToTime(preview!.hintStart)}</span>
                ) : null}
                {isSelected && !isLockedSlot(slot) ? (
                  <>
                    <div
                      className="absolute inset-x-0 top-0 h-6 touch-none cursor-ns-resize"
                      onPointerDown={(event) => handleHandlePointerDown(event, slot, "start")}
                      aria-hidden="true"
                    >
                      <div className="mx-auto mt-1.5 h-0.5 w-6 rounded-full bg-current opacity-60" />
                    </div>
                    <div
                      className="absolute inset-x-0 bottom-0 h-6 touch-none cursor-ns-resize"
                      onPointerDown={(event) => handleHandlePointerDown(event, slot, "end")}
                      aria-hidden="true"
                    >
                      <div className="mx-auto mb-1.5 mt-auto h-0.5 w-6 rounded-full bg-current opacity-60" />
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
          {preview && preview.kind === "create" ? (
            <div
              className={clsx("pointer-events-none absolute inset-x-1 rounded border-2 border-dashed", preview.valid ? "border-moss-600 bg-moss-600/10" : "border-red-500 bg-red-500/10")}
              style={{ top: minutesToPx(preview.start, PX_PER_HOUR), height: minutesToPx(preview.end - preview.start, PX_PER_HOUR) }}
            >
              <span className="p-1 text-[10px] text-ink-600 dark:text-ink-300">
                {minutesToTime(preview.start)}–{minutesToTime(preview.end)}
                {!preview.valid && preview.hintStart != null ? ` · free at ${minutesToTime(preview.hintStart)}` : ""}
              </span>
            </div>
          ) : null}
          {externalPreview?.kind === "single" ? (
            <div
              className={clsx(
                "pointer-events-none absolute inset-x-1 rounded border-2 border-dashed",
                externalPreview.valid ? "border-moss-600 bg-moss-600/10" : "border-red-500 bg-red-500/10"
              )}
              style={{ top: minutesToPx(externalPreview.start, PX_PER_HOUR), height: minutesToPx(externalPreview.end - externalPreview.start, PX_PER_HOUR) }}
            >
              <span className="p-1 text-[10px] text-ink-600 dark:text-ink-300">{externalPreview.label}</span>
            </div>
          ) : null}
          {externalPreview?.kind === "template"
            ? externalPreview.blocks.map((block, index) => (
                <div
                  key={index}
                  className={clsx("pointer-events-none absolute inset-x-1 rounded border-2 border-dashed opacity-80", slotTypeStyles[block.type])}
                  style={{ top: minutesToPx(block.start, PX_PER_HOUR), height: minutesToPx(block.end - block.start, PX_PER_HOUR) }}
                >
                  <span className="block truncate p-1 text-[10px]">{block.title}</span>
                </div>
              ))
            : null}
          {(suggestions ?? []).map((suggestion) => (
            <div
              key={suggestion.key}
              className={clsx(
                "absolute inset-x-1 flex items-center gap-1 overflow-hidden rounded border-2 border-dashed px-1.5 py-1 text-xs opacity-90",
                slotTypeStyles[suggestion.type]
              )}
              style={{ top: minutesToPx(suggestion.start, PX_PER_HOUR), height: Math.max(24, minutesToPx(suggestion.end - suggestion.start, PX_PER_HOUR)) }}
            >
              <span className="min-w-0 flex-1 truncate">Suggested: {suggestion.title}</span>
              <button
                className="shrink-0 rounded bg-white/70 p-1 text-moss-700 hover:bg-white dark:bg-black/40 dark:text-moss-400"
                onClick={() => onAcceptSuggestion?.(suggestion.key)}
                aria-label={`Accept suggested block ${suggestion.title}`}
              >
                <Check className="h-3 w-3" />
              </button>
              <button
                className="shrink-0 rounded bg-white/70 p-1 text-ink-600 hover:bg-white dark:bg-black/40 dark:text-ink-300"
                onClick={() => onDismissSuggestion?.(suggestion.key)}
                aria-label={`Dismiss suggested block ${suggestion.title}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
