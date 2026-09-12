"use client";

import { orderBy } from "firebase/firestore";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { clsx } from "clsx";
import { DayStrip } from "@/components/plan/day-strip";
import type { TimeGridHandle } from "@/components/plan/time-grid";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { generateDayTemplate } from "@/lib/ai/client";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { createDayTemplate } from "@/lib/firestore";
import { createSlot, materializeSlots, minutesFromTime, minutesToTime, shiftTemplateSlots, slotTypeStyles, sortedSlots, validateSlots } from "@/lib/schedule";
import { DEFAULT_ROUTINE_BLOCKS, routineSlotsForDate } from "@/lib/routine";
import {
  createTaskBlock,
  fillGaps,
  freshTemplateSlots,
  MINUTES_PER_DAY,
  nearestFreeGap,
  QUICK_BLOCK_PRESETS,
  rangeOverlapsSlots,
  snapMinutes,
  taskBlockMinutes,
  type QuickBlockPreset
} from "@/lib/timeline";
import { BUILTIN_DAY_TEMPLATES, materializeBuiltinDayTemplate, type BuiltinDayTemplate } from "@/lib/templates/builtin";
import type { DayTemplate, Goal, Priority, ScheduleSlot, Task } from "@/types";

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/** §4.4 "Tasks to schedule" — open tasks due today/this week, or already in progress, priority-sorted. */
function relevantTasks(tasks: Task[]): Task[] {
  const weekAhead = addDaysToKey(todayKey(), 7);
  return tasks
    .filter((task) => task.status !== "done")
    .filter((task) => task.status === "in_progress" || (task.dueDate && task.dueDate <= weekAhead))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31"));
}

/** `templateSlotSchema`'s "HH:mm" regex accepts any two digits per field — "99:99" passes it but
 * isn't a real time, and `minutesFromTime` would happily turn it into a nonsensical-but-numeric
 * minute count that could pass `validateSlots`' overlap math anyway. Checked separately from
 * `validateSlots` since it's a per-slot format concern, not a cross-slot schedule one.
 *
 * "24:00" is a real, valid end-of-day time in this app — `lib/timeline.ts`'s `parseTypedTime`
 * accepts it from a typed field, and `routineSlotsForDate`'s overnight split (Sleep) uses it as an
 * end time — so it must be accepted here too, matching `parseTypedTime`'s exact rule, not rejected
 * as "hour > 23". The AI's own prompt lists blackout windows using that same boundary (e.g. "Sleep:
 * 23:00-24:00"), and a model can echo it back into its own proposed slots. */
function isPlausibleTime(time: string): boolean {
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return false;
  if (hours === 24) return minutes === 0;
  return hours >= 0 && hours <= 23;
}

type TemplateSource = { id?: string; name: string; slots: ScheduleSlot[] };

type TrayGesture =
  | { pointerId: number; kind: "task"; task: Task }
  | { pointerId: number; kind: "quick"; preset: QuickBlockPreset }
  | { pointerId: number; kind: "template"; template: TemplateSource };

/**
 * plan/FocusOS-v2-Plan-Day-Timeline.md §4.4, DP3 — the inspector's other face when nothing is
 * selected: tasks, quick blocks, and templates, all draggable onto `TimeGrid` via the same
 * best-effort Pointer Events approach as DP2 (no `@dnd-kit/core` — see DP2's own note on why;
 * cross-container drag here works by capturing the pointer on the tray item itself and asking the
 * grid to `hitTest` the pointer's viewport coordinates, since capture redirects pointermove/up to
 * the capturing element regardless of what's visually underneath).
 *
 * Every drag has a non-drag equivalent per §9: a "Schedule" button per task/quick block (places
 * it via `nearestFreeGap` after `anchorMinute`), and each template's own click applies it anchored
 * at its own original start time instead of a dragged-to one.
 */
export function PlanTray({
  dateKey,
  tasks,
  workMinutes,
  anchorMinute,
  slots,
  gridRef,
  onCommit,
  announce
}: {
  /** Which day this tray's "Create with AI" grounds its routine-block blackout windows in — the
   * date `DayTimelineEditor` is currently showing, not necessarily today. */
  dateKey: string;
  tasks: Task[];
  workMinutes: number;
  /** Where the non-drag "Schedule" actions anchor their `nearestFreeGap` search — the same value DayTimelineEditor's own "N" shortcut and duplicate-block action use (now, or the day's default start on other dates). */
  anchorMinute: number;
  slots: ScheduleSlot[];
  gridRef: RefObject<TimeGridHandle | null>;
  onCommit: (next: ScheduleSlot[]) => void;
  /** DayTimelineEditor's §9 live-region announcer — lets `confirmFillGaps` say what happened when
   * a template's blocks all conflicted with something already on the day (including class blocks),
   * since silently doing nothing after a confirm click is indistinguishable from a broken button. */
  announce?: (message: string) => void;
}) {
  const { user } = useAuth();
  const { settings } = useUserSettings();
  const { items: userTemplates } = useUserCollection<DayTemplate>("dayTemplates", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));
  const dragRef = useRef<TrayGesture | null>(null);
  const [templateDrop, setTemplateDrop] = useState<{ templateId?: string; name: string; slots: ScheduleSlot[] } | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    if (!templateDrop) return;
    gridRef.current?.setExternalPreview({
      kind: "template",
      blocks: templateDrop.slots.map((slot) => ({ start: minutesFromTime(slot.startTime), end: minutesFromTime(slot.endTime), type: slot.type, title: slot.title }))
    });
    return () => gridRef.current?.setExternalPreview(null);
  }, [templateDrop, gridRef]);

  const openTasks = relevantTasks(tasks);

  function beginDrag(event: React.PointerEvent, gesture: TrayGesture) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    setTemplateDrop(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = gesture;
  }

  function handleDragMove(event: React.PointerEvent) {
    const gesture = dragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const grid = gridRef.current;
    const hit = grid?.hitTest(event.clientX, event.clientY);
    if (!grid || !hit) {
      grid?.setExternalPreview(null);
      return;
    }

    if (gesture.kind === "task") {
      if (hit.slotId) {
        const target = slots.find((slot) => slot.id === hit.slotId);
        if (target) {
          grid.setExternalPreview({
            kind: "single",
            start: minutesFromTime(target.startTime),
            end: minutesFromTime(target.endTime),
            valid: true,
            label: `Assign "${gesture.task.title}"`
          });
        }
        return;
      }
      const duration = taskBlockMinutes(gesture.task, workMinutes);
      const start = snapMinutes(hit.minute, 15);
      const end = start + duration;
      grid.setExternalPreview({ kind: "single", start, end, valid: end <= MINUTES_PER_DAY && !rangeOverlapsSlots(start, end, slots), label: gesture.task.title });
      return;
    }

    if (gesture.kind === "quick") {
      const start = snapMinutes(hit.minute, 15);
      const end = start + gesture.preset.minutes;
      grid.setExternalPreview({ kind: "single", start, end, valid: end <= MINUTES_PER_DAY && !rangeOverlapsSlots(start, end, slots), label: gesture.preset.label });
      return;
    }

    // template: live-shift the whole template so its earliest block starts at the hovered minute.
    const shifted = shiftTemplateSlots(gesture.template.slots, minutesToTime(snapMinutes(hit.minute, 15)));
    grid.setExternalPreview(
      shifted ? { kind: "template", blocks: shifted.map((slot) => ({ start: minutesFromTime(slot.startTime), end: minutesFromTime(slot.endTime), type: slot.type, title: slot.title })) } : null
    );
  }

  function handleDragEnd(event: React.PointerEvent) {
    const gesture = dragRef.current;
    dragRef.current = null;
    const grid = gridRef.current;
    grid?.setExternalPreview(null);
    if (!gesture) return;
    const hit = grid?.hitTest(event.clientX, event.clientY);

    // A quick-block chip is both the draggable element and the only clickable one (no room for a
    // separate "Schedule" button on a small chip) — a plain click never leaves the tray column, so
    // `hit` comes back null and this doubles as that click's non-drag equivalent. Deliberately not
    // implemented as a parallel `onClick`: with `setPointerCapture` in play, browsers disagree on
    // whether a compatibility `click` still fires after the pointer already moved onto the grid,
    // which would risk committing the block twice. Task/template have their own dedicated buttons
    // instead (guarded off from starting this same gesture — see their `onPointerDown`), so they
    // don't need this fallback.
    if (!hit) {
      if (gesture.kind === "quick") scheduleQuickNow(gesture.preset);
      return; // task/template dropped outside the grid entirely -> cancel, nothing committed
    }

    if (gesture.kind === "task") {
      if (hit.slotId) {
        const target = slots.find((slot) => slot.id === hit.slotId);
        if (!target) return;
        const ids = new Set(target.assignedTaskIds ?? []);
        ids.add(gesture.task.id);
        onCommit(slots.map((slot) => (slot.id === target.id ? { ...slot, assignedTaskIds: Array.from(ids) } : slot)));
        return;
      }
      const duration = taskBlockMinutes(gesture.task, workMinutes);
      const start = snapMinutes(hit.minute, 15);
      const end = start + duration;
      if (end > MINUTES_PER_DAY || rangeOverlapsSlots(start, end, slots)) return; // policy A: refuse, never touch `slots`
      onCommit([...slots, createTaskBlock(gesture.task, workMinutes, start)]);
      return;
    }

    if (gesture.kind === "quick") {
      const start = snapMinutes(hit.minute, 15);
      const end = start + gesture.preset.minutes;
      if (end > MINUTES_PER_DAY || rangeOverlapsSlots(start, end, slots)) return;
      onCommit([...slots, createSlot({ title: gesture.preset.label, type: gesture.preset.type, startTime: minutesToTime(start), endTime: minutesToTime(end) })]);
      return;
    }

    const shifted = shiftTemplateSlots(gesture.template.slots, minutesToTime(snapMinutes(hit.minute, 15)));
    if (!shifted) return; // would push a block past midnight -> refuse, matches the ghost showing nothing
    setTemplateDrop({ templateId: gesture.template.id, name: gesture.template.name, slots: shifted });
  }

  function scheduleTaskNow(task: Task) {
    const duration = taskBlockMinutes(task, workMinutes);
    const gapStart = nearestFreeGap(slots, anchorMinute, duration);
    if (gapStart === null) return;
    onCommit([...slots, createTaskBlock(task, workMinutes, gapStart)]);
  }

  function scheduleQuickNow(preset: QuickBlockPreset) {
    const gapStart = nearestFreeGap(slots, anchorMinute, preset.minutes);
    if (gapStart === null) return;
    onCommit([...slots, createSlot({ title: preset.label, type: preset.type, startTime: minutesToTime(gapStart), endTime: minutesToTime(gapStart + preset.minutes) })]);
  }

  function applyTemplateHere(template: TemplateSource) {
    setTemplateDrop({ templateId: template.id, name: template.name, slots: freshTemplateSlots(template.slots) });
  }

  // Template apply never overwrites anything — courses or otherwise. There used to be a "Replace
  // day" option that wholesale-replaced `slots` with the template's own, which silently discarded
  // any class blocks already on the day (they're never in a template, only ever materialized from
  // `courses`). `fillGaps` already skips any template block that would overlap something existing
  // (see its own doc comment), so it's the *only* apply mode now — a template can only add into
  // genuinely free time. "Clear all" (`DayTimelineEditor`'s header) is the explicit, separate way
  // to start a day over, and it too always keeps class blocks.
  function confirmFillGaps() {
    if (!templateDrop) return;
    const merged = fillGaps(slots, templateDrop.slots);
    const added = merged.length - slots.length;
    if (added === 0) {
      // Nothing fit anywhere free — every template block conflicted with something already on the
      // day (a class block or otherwise). Say so instead of silently no-opping, and skip the
      // commit: an identical array on the undo stack would just be a wasted Undo step.
      announce?.(`Every block in "${templateDrop.name}" overlapped something already on the day — nothing added.`);
    } else {
      onCommit(merged);
      const skipped = templateDrop.slots.length - added;
      announce?.(`Added ${added} block${added === 1 ? "" : "s"} from "${templateDrop.name}"${skipped > 0 ? `, skipped ${skipped} that overlapped` : ""}.`);
    }
    setTemplateDrop(null);
  }

  /** plan/FocusOS-v2-Routine-Blocks-and-AI-Templates.md §3.3 — feeds the AI the user's free-text
   * prompt plus routine blocks (as blackout windows the model is told not to overlap), open tasks,
   * and active goals as grounding context. The result is fed into the exact same `templateDrop`
   * confirm-bar/preview-ghost flow a dragged template already uses (`confirmFillGaps` above), so it
   * inherits the never-overwrite guarantee for free — no new placement logic. */
  async function generateWithAi() {
    if (!user || !aiPrompt.trim()) return;
    setAiBusy(true);
    setAiError("");
    try {
      const routineBlocks = routineSlotsForDate(settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS, dateKey).map((slot) => ({
        label: slot.title,
        type: slot.type,
        startTime: slot.startTime,
        endTime: slot.endTime
      }));
      const openTasks = relevantTasks(tasks).map((task) => ({ title: task.title, priority: task.priority, dueDate: task.dueDate }));
      const activeGoals = goals.filter((goal) => goal.status === "active").map((goal) => ({ title: goal.title }));
      const result = await generateDayTemplate(user, {
        prompt: aiPrompt.trim(),
        routineBlocks,
        openTasks,
        goals: activeGoals,
        packId: settings.packId
      });
      const materialized = materializeSlots(result.output.slots);
      // The schema (lib/ai/schemas.ts) only validates shape — "HH:mm" format, a known type enum,
      // 1-16 slots. It doesn't (and can't, being per-slot) catch two AI slots overlapping each
      // other, a slot ending before it starts, or an out-of-range hour/minute a regex alone can't
      // reject. Reusing `validateSlots` here means a malformed candidate never reaches the grid or
      // (via "Add & save as template") Firestore, where there'd be no UI left to repair it.
      const invalidTime = materialized.find((slot) => !isPlausibleTime(slot.startTime) || !isPlausibleTime(slot.endTime));
      const scheduleErrors = invalidTime ? [`${invalidTime.title} has an invalid time.`] : validateSlots(materialized);
      if (scheduleErrors.length > 0) {
        setAiError(`The AI produced an invalid schedule (${scheduleErrors[0]}) — try rephrasing the prompt.`);
        return;
      }
      setTemplateDrop({ templateId: undefined, name: result.output.name, slots: materialized });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Failed to generate a template.");
    } finally {
      setAiBusy(false);
    }
  }

  async function confirmSaveAsTemplate() {
    if (!templateDrop || !user || savingTemplate) return;
    setSavingTemplate(true);
    try {
      await createDayTemplate(user.uid, { name: templateDrop.name, slots: sortedSlots(templateDrop.slots) });
      confirmFillGaps();
    } finally {
      setSavingTemplate(false);
    }
  }

  // Fresh ids only need to be minted once per template list change, not on every render (every
  // commit, every templateDrop change) — `applyTemplateHere`/the drag path already re-freshen at
  // apply time, so these don't need to churn to stay unique.
  const templateSources: TemplateSource[] = useMemo(
    () => [
      ...userTemplates.map((template) => ({ id: template.id, name: template.name, slots: freshTemplateSlots(template.slots) })),
      ...BUILTIN_DAY_TEMPLATES.map((builtin) => ({ name: builtin.name, slots: freshTemplateSlots(materializeBuiltinDayTemplate(builtin).slots) }))
    ],
    [userTemplates]
  );

  return (
    <div className="space-y-5 text-sm">
      {templateDrop ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-moss-600/40 bg-moss-600/10 px-3 py-2 text-xs text-moss-800 dark:text-moss-300">
          <span className="flex-1">
            Apply &quot;{templateDrop.name}&quot; starting {templateDrop.slots[0]?.startTime}?
          </span>
          <button className="btn-primary py-1 text-[11px]" onClick={confirmFillGaps} disabled={savingTemplate}>Add (skips conflicts)</button>
          <button className="btn-secondary py-1 text-[11px]" onClick={confirmSaveAsTemplate} disabled={savingTemplate}>
            {savingTemplate ? "Saving..." : "Add & save as template"}
          </button>
          <button className="btn-secondary py-1 text-[11px]" onClick={() => setTemplateDrop(null)} disabled={savingTemplate}>Cancel</button>
        </div>
      ) : null}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Tasks to schedule</h3>
        {openTasks.length === 0 ? (
          <p className="text-xs text-ink-500">No tasks due soon.</p>
        ) : (
          <ul className="space-y-1.5">
            {openTasks.map((task) => (
              <li
                key={task.id}
                onPointerDown={(event) => {
                  // The "Schedule" button below is its own click target, not a drag handle — letting
                  // its pointerdown bubble into a drag gesture is what previously let a keyboard-free
                  // click phantom-drag and, per DP2/DP3 review, wipe an unrelated pending template
                  // decision as a side effect.
                  if (event.target instanceof HTMLElement && event.target.closest("button")) return;
                  beginDrag(event, { pointerId: event.pointerId, kind: "task", task });
                }}
                onPointerMove={handleDragMove}
                onPointerUp={handleDragEnd}
                onPointerCancel={() => {
                  dragRef.current = null;
                  gridRef.current?.setExternalPreview(null);
                }}
                className="flex touch-none items-center gap-2 rounded-md border border-ink-200 px-2 py-1.5 text-xs dark:border-ink-800"
              >
                <span className="flex-1 truncate">{task.title}</span>
                <button className="btn-secondary px-1.5 py-1 text-[11px]" onClick={() => scheduleTaskNow(task)} aria-label={`Schedule ${task.title}`}>
                  Schedule
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Quick blocks</h3>
        <div className="flex flex-wrap gap-2">
          {QUICK_BLOCK_PRESETS.map((preset) => (
            <button
              key={preset.type}
              onPointerDown={(event) => beginDrag(event, { pointerId: event.pointerId, kind: "quick", preset })}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={() => {
                dragRef.current = null;
                gridRef.current?.setExternalPreview(null);
              }}
              onKeyDown={(event) => {
                // Keyboard activation never goes through pointerdown/up, so this can't double-fire
                // alongside the drag path below — it's the WCAG 2.5.7 non-drag equivalent (§9).
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  scheduleQuickNow(preset);
                }
              }}
              className={clsx("touch-none rounded-md border px-2 py-1 text-[11px] font-medium", slotTypeStyles[preset.type])}
              title="Drag onto the grid, or click to drop at the next free gap"
            >
              {preset.label} · {preset.minutes}m
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Templates</h3>
        <div className="mb-3 space-y-1.5 rounded-md border border-ink-200 p-2 dark:border-ink-800">
          <label className="flex items-center gap-1 text-[11px] font-medium text-ink-500">
            <Sparkles className="h-3 w-3" />
            Create with AI
          </label>
          <textarea
            className="input min-h-14 text-xs"
            value={aiPrompt}
            onChange={(event) => setAiPrompt(event.target.value)}
            placeholder="A balanced writing day with a long lunch..."
          />
          <button className="btn-secondary w-full py-1 text-[11px]" onClick={generateWithAi} disabled={aiBusy || !aiPrompt.trim()}>
            {aiBusy ? "Generating..." : "Generate"}
          </button>
          {aiError ? <p className="text-[11px] text-red-600 dark:text-red-400">{aiError}</p> : null}
        </div>
        <div className="space-y-2">
          {templateSources.map((template, index) => (
            <div
              key={template.id ?? `builtin-${index}`}
              onPointerDown={(event) => {
                // Same reasoning as the task row above — the "Apply" button is its own click
                // target, not a drag handle, and must never start (or clobber) a drag/ghost.
                if (event.target instanceof HTMLElement && event.target.closest("button")) return;
                beginDrag(event, { pointerId: event.pointerId, kind: "template", template });
              }}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={() => {
                dragRef.current = null;
                gridRef.current?.setExternalPreview(null);
              }}
              className="touch-none rounded-md border border-ink-200 p-2 dark:border-ink-800"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{template.name}</span>
                <button className="btn-secondary px-1.5 py-1 text-[11px]" onClick={() => applyTemplateHere(template)}>
                  Apply
                </button>
              </div>
              <div className="mt-1.5">
                <DayStrip variant="mini" slots={template.slots} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
