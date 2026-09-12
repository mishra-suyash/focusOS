"use client";

import { orderBy } from "firebase/firestore";
import { clsx } from "clsx";
import { Plus, Redo2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BlockInspector } from "@/components/plan/block-inspector";
import { DayStrip } from "@/components/plan/day-strip";
import { PlanTray } from "@/components/plan/plan-tray";
import { TimeGrid, type TimeGridHandle } from "@/components/plan/time-grid";
import { useCurrentMinute } from "@/hooks/use-current-minute";
import { useDayAutosave } from "@/hooks/use-day-autosave";
import { useUndoStack } from "@/hooks/use-undo-stack";
import { useDay } from "@/hooks/use-day";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { createDayTemplate, saveDayFields } from "@/lib/firestore";
import { createSlot, formatMinutes, minutesFromTime, minutesToTime, slotDuration, sortedSlots } from "@/lib/schedule";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { MINUTES_PER_DAY, nearestFreeGap, rangeOverlapsSlots, shiftRestOfDay } from "@/lib/timeline";
import type { DailySchedule, PomodoroSession, ScheduleSlot, Task } from "@/types";

const DEFAULT_SCROLL_MINUTE = 8 * 60;
const DELETE_UNDO_WINDOW_MS = 6_000;
const ARROW_SNAP_MINUTES = 15;
const ARROW_HOUR_MINUTES = 60;

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
}

/**
 * plan/FocusOS-v2-Plan-Day-Timeline.md DP2 — "off" (everyone, since `planDayTimeline` is hidden)
 * keeps the old stacked-forms editor in `app/(app)/plan/day/page.tsx` untouched; this is "on".
 *
 * This component now owns the save model end to end (§6): it takes the live `schedule` doc
 * (for `updatedAt`/`templateId`), not a `slots` array the parent syncs — `useUndoStack` holds the
 * working copy, and `useDayAutosave` persists it on a debounce. The parent only gets a mirror via
 * `onSlotsChange`, for its own secondary features ("Save as template", etc.) — it no longer
 * overwrites this component's state on every remote snapshot, which is what makes autosave safe:
 * see `useDayAutosave`'s two-tab guard for why that would otherwise fight this component's own
 * writes echoing back through the same Firestore listener.
 *
 * Drag (create/move/resize in `TimeGrid`) and keyboard (this file's `onKeyDown`) both funnel
 * through the same `commitSlots`, so "zero writes during drag" and "one write per gesture" hold
 * for both input methods identically — verifiable by reading (nothing here calls `scheduleSave`
 * except from a finished gesture or a discrete keyboard command), not by dragging something.
 */
export function DayTimelineEditor({
  uid,
  dateKey,
  schedule,
  tasks,
  onSlotsChange
}: {
  uid: string;
  dateKey: string;
  schedule: DailySchedule | null;
  tasks: Task[];
  onSlotsChange: (slots: ScheduleSlot[]) => void;
}) {
  const isToday = dateKey === todayKey();
  const nowMinute = useCurrentMinute();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewportRange, setViewportRange] = useState<{ startMinute: number; endMinute: number } | null>(null);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [showDeleteToast, setShowDeleteToast] = useState(false);
  const [templateOverride, setTemplateOverride] = useState<{ active: boolean; value?: string }>({ active: false });
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [shiftMenuOpen, setShiftMenuOpen] = useState(false);
  const [shiftCustomMinutes, setShiftCustomMinutes] = useState("");
  const [announcement, setAnnouncement] = useState({ text: "", seq: 0 });
  const [traySheetOpen, setTraySheetOpen] = useState(false);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const gridRef = useRef<TimeGridHandle>(null);
  const deleteToastTimeoutRef = useRef<number | null>(null);
  const { settings } = useUserSettings();
  const workMinutes = settings.workMinutes ?? 25;
  // S2 "planned vs done" lane — this day's actual completed focus sessions, for `DayStrip`'s
  // optional lane. `useUserCollection` fetches every session (matches the dashboard's own pattern);
  // filtering to this date happens client-side below.
  const { items: allSessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [orderBy("completedAt", "desc")], []));
  const todaySessions = useMemo(() => allSessions.filter((session) => session.completedAt.startsWith(dateKey)), [allSessions, dateKey]);

  // S3 "Suggestions for tomorrow" ghosts — the evening rollup for the day *before* this one
  // proposes blocks for this date; `day.rollup.slotDecisions` (keyed by index, shared with the
  // Daily review page's own accept/dismiss buttons — see `EveningRollupCard`) tracks which of them
  // are still undecided.
  const previousDateKey = addDaysToKey(dateKey, -1);
  const { day: previousDay } = useDay(previousDateKey);
  const proposedSlots = previousDay?.rollup?.proposedSlots ?? [];
  const slotDecisions = previousDay?.rollup?.slotDecisions ?? {};
  const suggestions = proposedSlots
    .map((proposed, index) => ({ key: String(index), proposed }))
    .filter(({ key }) => !slotDecisions[key])
    .map(({ key, proposed }) => ({
      key,
      title: proposed.title,
      type: proposed.type,
      start: minutesFromTime(proposed.startTime),
      end: minutesFromTime(proposed.endTime)
    }));

  const { present: slots, action, canUndo, canRedo, commit, undo, redo, reset } = useUndoStack<ScheduleSlot[]>(sortedSlots(schedule?.slots ?? []));
  // Applying a template (tray, DP3) changes what this day should save as `templateId` before
  // Firestore's snapshot round-trips back with the same value — an explicit local override wins
  // until the next "Reload", rather than the derived `schedule?.templateId` racing the write.
  const templateId = templateOverride.active ? templateOverride.value : schedule?.templateId;
  const { status, scheduleSave, conflict, forceSave, dismissConflict } = useDayAutosave({
    uid,
    dateKey,
    templateId,
    remoteUpdatedAt: schedule?.updatedAt
  });

  const selectedSlot = slots.find((slot) => slot.id === selectedId) ?? null;
  // §4 mobile layout — "inspector as a bottom sheet on tap, tray as a floating '+' that opens a
  // bottom sheet". Selecting a block always opens it (inspector takes priority over the tray); the
  // "+" is the only way to open the tray with nothing selected.
  const mobileSheetOpen = selectedSlot != null || traySheetOpen;

  function announce(message: string) {
    // `seq` forces a distinct render (via the live region's `key` below) even when `message` is
    // identical to the last announcement (e.g. holding an arrow key against the same neighbor
    // twice) — most screen readers only speak a live region when its content actually changes, and
    // a remount is a real DOM mutation where an identical-string `setState` wouldn't be. Synchronous
    // and un-timered, unlike a clear-then-`setTimeout` approach, which would race a second
    // announcement arriving within the delay and leaves a timer with no cleanup on unmount.
    setAnnouncement((previous) => ({ text: message, seq: previous.seq + 1 }));
  }

  function closeMobileSheet() {
    setSelectedId(null);
    setTraySheetOpen(false);
  }

  const plannedMinutes = slots.reduce((sum, slot) => sum + slotDuration(slot), 0);
  const deepWorkMinutes = slots.filter((slot) => slot.type === "deep_work").reduce((sum, slot) => sum + slotDuration(slot), 0);
  const freeMinutes = Math.max(0, MINUTES_PER_DAY - plannedMinutes);

  const initialScrollMinute = isToday
    ? Math.max(0, nowMinute - 60)
    : slots.length > 0
      ? Math.max(0, Math.min(...slots.map((slot) => minutesFromTime(slot.startTime))) - 30)
      : DEFAULT_SCROLL_MINUTE;

  // Persists every real edit (commit/undo/redo), skipping the initial mount (nothing changed yet)
  // and `reset` (accepting an external change shouldn't write it straight back — see `reset`'s
  // own two callers below, "Reload" and the initial-load path, neither of which is a local edit).
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    onSlotsChange(slots);
    if (action !== "reset") scheduleSave(slots);
  }, [slots, action]);

  // Runs after React has committed the render whose `slots` no longer contains the deleted block,
  // so the target node is guaranteed mounted by the time this fires — unlike a `requestAnimationFrame`
  // called directly from `deleteSelected`, which isn't ordered against that commit.
  useEffect(() => {
    if (!pendingFocusId) return;
    gridRef.current?.focusSlot(pendingFocusId);
    setPendingFocusId(null);
  }, [slots, pendingFocusId]);

  function commitSlots(next: ScheduleSlot[]) {
    commit(sortedSlots(next));
  }

  function handleGridCommit(next: ScheduleSlot[]) {
    if (next.length === slots.length + 1) {
      const added = next.find((candidate) => !slots.some((existing) => existing.id === candidate.id));
      if (added) setJustCreatedId(added.id);
    }
    commitSlots(next);
  }

  function updateSlot(next: ScheduleSlot) {
    setJustCreatedId(null);
    commitSlots(slots.map((slot) => (slot.id === next.id ? next : slot)));
  }

  function deleteSelected(id: string) {
    const deleted = slots.find((slot) => slot.id === id);
    const ordered = sortedSlots(slots);
    const index = ordered.findIndex((slot) => slot.id === id);
    // §9 "after delete, focus moves to the next block in time" — falling back to the previous one
    // when the deleted block was last, since there's nothing after it to land on. Actually moving
    // focus happens in the effect below, once React has committed the render that no longer
    // contains `id` — a `requestAnimationFrame` right here isn't ordered against that commit.
    const nextFocusId = ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null;
    commitSlots(slots.filter((slot) => slot.id !== id));
    if (selectedId === id) setSelectedId(nextFocusId);
    setJustCreatedId(null); // a delete-then-undo shouldn't leave a stale autofocus armed for whichever block gets selected next
    setPendingFocusId(nextFocusId);
    setShowDeleteToast(true);
    announce(`${deleted?.title ?? "Block"} deleted, press Control Z to undo.`);
    if (deleteToastTimeoutRef.current) window.clearTimeout(deleteToastTimeoutRef.current);
    deleteToastTimeoutRef.current = window.setTimeout(() => setShowDeleteToast(false), DELETE_UNDO_WINDOW_MS);
  }

  function moveSelected(slot: ScheduleSlot, deltaMinutes: number) {
    const start = minutesFromTime(slot.startTime);
    const duration = minutesFromTime(slot.endTime) - start;
    const nextStart = Math.min(Math.max(0, start + deltaMinutes), MINUTES_PER_DAY - duration);
    const nextEnd = nextStart + duration;
    if (rangeOverlapsSlots(nextStart, nextEnd, slots, slot.id)) {
      const overlap = slots.find((item) => item.id !== slot.id && minutesFromTime(item.startTime) < nextEnd && nextStart < minutesFromTime(item.endTime));
      announce(overlap ? `Cannot move, overlaps ${overlap.title}.` : "Cannot move there.");
      return;
    }
    commitSlots(slots.map((item) => (item.id === slot.id ? { ...item, startTime: minutesToTime(nextStart), endTime: minutesToTime(nextEnd) } : item)));
    announce(`${slot.title} moved to ${minutesToTime(nextStart)} to ${minutesToTime(nextEnd)}.`);
  }

  function resizeSelected(slot: ScheduleSlot, edge: "start" | "end", deltaMinutes: number) {
    const start = minutesFromTime(slot.startTime);
    const end = minutesFromTime(slot.endTime);
    const nextStart = edge === "start" ? Math.max(0, Math.min(end - ARROW_SNAP_MINUTES, start + deltaMinutes)) : start;
    const nextEnd = edge === "end" ? Math.min(MINUTES_PER_DAY, Math.max(start + ARROW_SNAP_MINUTES, end + deltaMinutes)) : end;
    if (rangeOverlapsSlots(nextStart, nextEnd, slots, slot.id)) {
      const overlap = slots.find((item) => item.id !== slot.id && minutesFromTime(item.startTime) < nextEnd && nextStart < minutesFromTime(item.endTime));
      announce(overlap ? `Cannot resize, overlaps ${overlap.title}.` : "Cannot resize there.");
      return;
    }
    commitSlots(slots.map((item) => (item.id === slot.id ? { ...item, startTime: minutesToTime(nextStart), endTime: minutesToTime(nextEnd) } : item)));
    announce(`${slot.title} resized to ${minutesToTime(nextStart)} to ${minutesToTime(nextEnd)}.`);
  }

  function duplicateSelected() {
    const slot = slots.find((item) => item.id === selectedId);
    if (!slot) return;
    const duration = minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime);
    const gapStart = nearestFreeGap(slots, minutesFromTime(slot.endTime), duration);
    if (gapStart === null) {
      announce("No free gap to duplicate into.");
      return;
    }
    const copy = createSlot({ ...slot, id: undefined, startTime: minutesToTime(gapStart), endTime: minutesToTime(gapStart + duration) });
    setJustCreatedId(copy.id);
    commitSlots([...slots, copy]);
    setSelectedId(copy.id);
    announce(`${copy.title} duplicated to ${copy.startTime} to ${copy.endTime}.`);
  }

  function createAtFocusedTime() {
    const anchor = selectedSlot ? minutesFromTime(selectedSlot.endTime) : isToday ? nowMinute : DEFAULT_SCROLL_MINUTE;
    const gapStart = nearestFreeGap(slots, anchor, 60);
    if (gapStart === null) {
      announce("No free gap to create a block in.");
      return;
    }
    const next = createSlot({ startTime: minutesToTime(gapStart), endTime: minutesToTime(gapStart + 60) });
    setJustCreatedId(next.id);
    commitSlots([...slots, next]);
    setSelectedId(next.id);
    announce(`Block created, ${next.startTime} to ${next.endTime}.`);
  }

  function handleReload() {
    if (schedule) reset(sortedSlots(schedule.slots));
    setTemplateOverride({ active: false }); // defer back to the reloaded doc's own templateId, not our stale local guess
    dismissConflict();
  }

  function handleKeepMine() {
    void forceSave(slots);
  }

  /** §4.4 tray — "Replace day" on a template drop; "Fill gaps only" goes through `commitSlots` directly since it never changes `templateId`. */
  function handleApplyTemplate(next: ScheduleSlot[], appliedTemplateId: string | undefined) {
    setTemplateOverride({ active: true, value: appliedTemplateId });
    commitSlots(next);
  }

  /** S3 — accepting a suggestion ghost adds it to *this* day's own `slots` via the normal `commitSlots`
   * path (so it autosaves exactly like any other add), while the decision itself is a separate write
   * to `days/{previousDateKey}` — a different document that no live `DayTimelineEditor` instance for
   * that other date could be holding stale state for, so it's safe to write directly (unlike
   * `dailySchedules`, which is why the old "Browse templates" dialog got hidden behind this same flag
   * in DP3). Declining to place it (an overlap) leaves the decision unset, not "dismissed" — the
   * user can clear a spot and try again rather than losing the suggestion to a conflict it never chose. */
  function handleAcceptSuggestion(key: string) {
    const suggestion = suggestions.find((item) => item.key === key);
    if (!suggestion) return;
    if (rangeOverlapsSlots(suggestion.start, suggestion.end, slots)) {
      announce(`Cannot place ${suggestion.title} there — it overlaps another block.`);
      return;
    }
    commitSlots([...slots, createSlot({ title: suggestion.title, type: suggestion.type, startTime: minutesToTime(suggestion.start), endTime: minutesToTime(suggestion.end) })]);
    void saveDayFields(uid, previousDateKey, { [`rollup.slotDecisions.${key}`]: "accepted" });
    announce(`${suggestion.title} added, ${minutesToTime(suggestion.start)} to ${minutesToTime(suggestion.end)}.`);
  }

  function handleDismissSuggestion(key: string) {
    const suggestion = suggestions.find((item) => item.key === key);
    void saveDayFields(uid, previousDateKey, { [`rollup.slotDecisions.${key}`]: "dismissed" });
    announce(`${suggestion?.title ?? "Suggestion"} dismissed.`);
  }

  async function handleSaveTemplate() {
    if (!templateName.trim() || slots.length === 0) return;
    await createDayTemplate(uid, { name: templateName.trim(), description: templateDescription.trim() || undefined, slots: sortedSlots(slots) });
    setTemplateName("");
    setTemplateDescription("");
    setSaveTemplateOpen(false);
  }

  /** S1 "Running late? Shift rest of day" — the only place `Shift`-drag's ripple math is reachable without a pointer, and today-only (it anchors at `nowMinute`, which has no meaning on another date). */
  function handleShiftRestOfDay(minutesDelta: number) {
    setShiftMenuOpen(false);
    setShiftCustomMinutes("");
    const result = shiftRestOfDay(slots, nowMinute, minutesDelta);
    if (!result) {
      announce("Couldn't shift the rest of the day — it would overlap a locked block or run past the end of the day.");
      return;
    }
    commitSlots(result);
    announce(`Rest of the day shifted by ${minutesDelta > 0 ? "+" : ""}${minutesDelta} minutes.`);
  }

  // §5's keyboard column — the non-drag equivalent for every mouse gesture. Skips typing targets
  // so this never hijacks the inspector's own inputs. Live announcements and focus management
  // beyond this are DP4's job (accessibility + mobile).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;

      if (event.key === "Escape" && (traySheetOpen || selectedId)) {
        closeMobileSheet();
        return;
      }
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          if (canRedo) {
            redo();
            announce("Redo.");
          }
        } else if (canUndo) {
          undo();
          announce("Undo.");
        }
        return;
      }
      if (meta && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (event.key === "t" || event.key === "T") {
        if (isToday) gridRef.current?.scrollToMinute(nowMinute);
        return;
      }
      if (event.key === "n" || event.key === "N") {
        createAtFocusedTime();
        return;
      }

      const selected = selectedId ? slots.find((slot) => slot.id === selectedId) : null;
      if (!selected || selected.type === "class") return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelected(selected.id);
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const sign = event.key === "ArrowUp" ? -1 : 1;
        if (event.altKey) {
          resizeSelected(selected, event.shiftKey ? "start" : "end", sign * ARROW_SNAP_MINUTES);
        } else {
          moveSelected(selected, sign * (event.shiftKey ? ARROW_HOUR_MINUTES : ARROW_SNAP_MINUTES));
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, slots, canUndo, canRedo, isToday, nowMinute, traySheetOpen]);

  useEffect(() => {
    return () => {
      if (deleteToastTimeoutRef.current) window.clearTimeout(deleteToastTimeoutRef.current);
    };
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-500">
        <span>
          Deep work {formatMinutes(deepWorkMinutes)} · Planned {formatMinutes(plannedMinutes)} · Free {formatMinutes(freeMinutes)}
        </span>
        <div className="flex items-center gap-2">
          <SaveStatusPill status={status} onRetry={() => scheduleSave(slots)} />
          <button className="btn-secondary px-2 py-1.5" onClick={undo} disabled={!canUndo} aria-label="Undo">
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button className="btn-secondary px-2 py-1.5" onClick={redo} disabled={!canRedo} aria-label="Redo">
            <Redo2 className="h-3.5 w-3.5" />
          </button>
          <button className="btn-secondary py-1.5 text-xs" onClick={createAtFocusedTime}>
            <Plus className="h-3.5 w-3.5" />
            Add block
          </button>
          {isToday ? (
            <div className="relative">
              <button className="btn-secondary py-1.5 text-xs" onClick={() => setShiftMenuOpen((open) => !open)}>
                Running late?
              </button>
              {shiftMenuOpen ? (
                <div className="absolute right-0 top-full z-20 mt-1 w-56 space-y-2 rounded-md border border-ink-200 bg-white p-3 shadow-lg dark:border-ink-700 dark:bg-ink-900">
                  <p className="text-xs text-ink-500">Shift every block after now later — locked class blocks never move.</p>
                  <div className="flex gap-2">
                    <button className="btn-secondary flex-1 py-1 text-xs" onClick={() => handleShiftRestOfDay(15)}>
                      +15m
                    </button>
                    <button className="btn-secondary flex-1 py-1 text-xs" onClick={() => handleShiftRestOfDay(30)}>
                      +30m
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      className="input py-1 text-xs"
                      type="number"
                      value={shiftCustomMinutes}
                      onChange={(event) => setShiftCustomMinutes(event.target.value)}
                      placeholder="Custom minutes"
                    />
                    <button
                      className="btn-primary py-1 text-xs"
                      onClick={() => handleShiftRestOfDay(Number(shiftCustomMinutes))}
                      disabled={!shiftCustomMinutes || Number.isNaN(Number(shiftCustomMinutes)) || Number(shiftCustomMinutes) === 0}
                    >
                      Apply
                    </button>
                  </div>
                  <button className="btn-secondary w-full py-1 text-xs" onClick={() => setShiftMenuOpen(false)}>
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="relative">
            <button className="btn-secondary py-1.5 text-xs" onClick={() => setSaveTemplateOpen((open) => !open)} disabled={slots.length === 0}>
              Save as template
            </button>
            {saveTemplateOpen ? (
              <div className="absolute right-0 top-full z-20 mt-1 w-64 space-y-2 rounded-md border border-ink-200 bg-white p-3 shadow-lg dark:border-ink-700 dark:bg-ink-900">
                <input className="input" value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Template name" />
                <textarea
                  className="input min-h-16"
                  value={templateDescription}
                  onChange={(event) => setTemplateDescription(event.target.value)}
                  placeholder="Optional description"
                />
                <div className="flex justify-end gap-2">
                  <button className="btn-secondary py-1 text-xs" onClick={() => setSaveTemplateOpen(false)}>
                    Cancel
                  </button>
                  <button className="btn-primary py-1 text-xs" onClick={handleSaveTemplate} disabled={!templateName.trim()}>
                    Save
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {conflict ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <span className="flex-1">This day changed in another tab.</span>
          <button className="btn-secondary py-1 text-[11px]" onClick={handleReload}>
            Reload
          </button>
          <button className="btn-secondary py-1 text-[11px]" onClick={handleKeepMine}>
            Keep mine
          </button>
        </div>
      ) : null}

      <DayStrip
        variant="full"
        slots={slots}
        isToday={isToday}
        nowMinute={nowMinute}
        viewportRange={viewportRange}
        onScrubTo={(minute) => gridRef.current?.scrollToMinute(minute)}
        sessions={todaySessions}
      />

      {/* §9 live region — announces the outcome of every drag/keyboard gesture (see `announce`
          calls throughout this file and the `announce` prop into `TimeGrid`). Kept permanently in
          the DOM with `role="status"`/`aria-live="polite"` so screen readers pick up on text
          *changes*, not on the region merely existing. */}
      <div role="status" aria-live="polite" className="sr-only" key={announcement.seq}>
        {announcement.text}
      </div>

      <section aria-label="Day timeline" aria-describedby="timeline-keyboard-help" className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <p id="timeline-keyboard-help" className="sr-only">
          Tab to a block to select it. Arrow keys move the selected block by 15 minutes, hold Shift for 1 hour. Alt plus
          arrow keys resizes the end, Alt and Shift together resizes the start. Press N to create a block at the focused
          time, Delete to remove the selected block, Control or Command D to duplicate it, T to jump to now, and Control or
          Command Z to undo.
        </p>
        <TimeGrid
          ref={gridRef}
          slots={slots}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCommit={handleGridCommit}
          isToday={isToday}
          nowMinute={nowMinute}
          initialScrollMinute={initialScrollMinute}
          onViewportChange={setViewportRange}
          announce={announce}
          suggestions={suggestions}
          onAcceptSuggestion={handleAcceptSuggestion}
          onDismissSuggestion={handleDismissSuggestion}
        />

        {mobileSheetOpen ? (
          <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={closeMobileSheet} aria-hidden="true" />
        ) : null}
        <div
          className={clsx(
            "card p-4",
            mobileSheetOpen ? "fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-b-none rounded-t-2xl" : "hidden",
            "lg:static lg:z-auto lg:block lg:max-h-none lg:overflow-visible lg:rounded-lg"
          )}
        >
          <div className="mb-2 flex items-center justify-between lg:hidden">
            <span className="text-sm font-semibold">{selectedSlot ? "Edit block" : "Add to day"}</span>
            <button className="btn-secondary px-2 py-1" onClick={closeMobileSheet} aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          {selectedSlot ? (
            <BlockInspector
              key={selectedSlot.id}
              slot={selectedSlot}
              allSlots={slots}
              tasks={tasks}
              onChange={updateSlot}
              onDelete={() => deleteSelected(selectedSlot.id)}
              autoFocusTitle={selectedSlot.id === justCreatedId}
            />
          ) : (
            <>
              <p className="mb-3 text-sm text-ink-500">Select a block to edit it, drag on the grid to create one, or press N.</p>
              <PlanTray
                tasks={tasks}
                workMinutes={workMinutes}
                anchorMinute={isToday ? nowMinute : DEFAULT_SCROLL_MINUTE}
                slots={slots}
                gridRef={gridRef}
                onCommit={commitSlots}
                onApplyTemplate={handleApplyTemplate}
              />
            </>
          )}
        </div>
      </section>

      {!mobileSheetOpen ? (
        <button
          className="fixed bottom-4 right-4 z-30 rounded-full bg-moss-600 p-4 text-white shadow-lg lg:hidden"
          onClick={() => setTraySheetOpen(true)}
          aria-label="Open tasks and templates"
        >
          <Plus className="h-5 w-5" />
        </button>
      ) : null}

      {showDeleteToast ? (
        <div className="fixed bottom-20 right-4 z-50 flex items-center gap-3 rounded-md border border-ink-200 bg-white px-4 py-2.5 text-sm shadow-lg dark:border-ink-700 dark:bg-ink-900 lg:bottom-4">
          <span>Block deleted.</span>
          <button
            className="font-medium text-moss-700 hover:underline dark:text-moss-400"
            onClick={() => {
              setShowDeleteToast(false);
              if (canUndo) undo();
            }}
          >
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SaveStatusPill({ status, onRetry }: { status: "idle" | "saving" | "saved" | "offline" | "error"; onRetry: () => void }) {
  if (status === "saving") return <span>Saving…</span>;
  if (status === "saved") return <span className="text-moss-600 dark:text-moss-400">Saved ✓</span>;
  if (status === "offline") return <span className="text-amber-600 dark:text-amber-400">Offline, will retry</span>;
  if (status === "error") {
    return (
      <span className="text-red-600 dark:text-red-400">
        Couldn&apos;t save —{" "}
        <button className="underline" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  }
  return null;
}
