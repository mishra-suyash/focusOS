"use client";

import { orderBy } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { clsx } from "clsx";
import { DayStrip } from "@/components/plan/day-strip";
import type { TimeGridHandle } from "@/components/plan/time-grid";
import { useUserCollection } from "@/hooks/use-user-collection";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { createSlot, minutesFromTime, minutesToTime, shiftTemplateSlots, slotTypeStyles, sortedSlots } from "@/lib/schedule";
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
import type { DayTemplate, Priority, ScheduleSlot, Task } from "@/types";

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/** §4.4 "Tasks to schedule" — open tasks due today/this week, or already in progress, priority-sorted. */
function relevantTasks(tasks: Task[]): Task[] {
  const weekAhead = addDaysToKey(todayKey(), 7);
  return tasks
    .filter((task) => task.status !== "done")
    .filter((task) => task.status === "in_progress" || (task.dueDate && task.dueDate <= weekAhead))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31"));
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
  tasks,
  workMinutes,
  anchorMinute,
  slots,
  gridRef,
  onCommit,
  onApplyTemplate
}: {
  tasks: Task[];
  workMinutes: number;
  /** Where the non-drag "Schedule" actions anchor their `nearestFreeGap` search — the same value DayTimelineEditor's own "N" shortcut and duplicate-block action use (now, or the day's default start on other dates). */
  anchorMinute: number;
  slots: ScheduleSlot[];
  gridRef: RefObject<TimeGridHandle | null>;
  onCommit: (next: ScheduleSlot[]) => void;
  onApplyTemplate: (next: ScheduleSlot[], templateId: string | undefined) => void;
}) {
  const { items: userTemplates } = useUserCollection<DayTemplate>("dayTemplates", useMemo(() => [orderBy("createdAt", "desc")], []));
  const dragRef = useRef<TrayGesture | null>(null);
  const [templateDrop, setTemplateDrop] = useState<{ templateId?: string; name: string; slots: ScheduleSlot[] } | null>(null);

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

  function confirmReplace() {
    if (!templateDrop) return;
    onApplyTemplate(sortedSlots(templateDrop.slots), templateDrop.templateId);
    setTemplateDrop(null);
  }

  function confirmFillGaps() {
    if (!templateDrop) return;
    onCommit(fillGaps(slots, templateDrop.slots));
    setTemplateDrop(null);
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
          <button className="btn-primary py-1 text-[11px]" onClick={confirmReplace}>Replace day</button>
          <button className="btn-secondary py-1 text-[11px]" onClick={confirmFillGaps}>Fill gaps only</button>
          <button className="btn-secondary py-1 text-[11px]" onClick={() => setTemplateDrop(null)}>Cancel</button>
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
