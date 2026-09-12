"use client";

import Link from "next/link";
import { Lock, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MoreOptions } from "@/components/more-options";
import { TypedTimeInput } from "@/components/plan/typed-time-input";
import { isLockedSlot, minutesFromTime, slotTypeLabels, slotTypes } from "@/lib/schedule";
import { categoryForSlotType, rangeOverlapsSlots } from "@/lib/timeline";
import type { ScheduleSlot, ScheduleSlotType, Task } from "@/types";

/**
 * plan/FocusOS-v2-Plan-Day-Timeline.md §4.3 — opens for whichever block is selected in TimeGrid.
 * Deliberately "reusing current field components" per DP1's own scope line: the same fields the
 * old stacked SlotEditor had (type select, note, status, tasks), not yet the chip-row /
 * collapsed-note / auto-status redesign §4.3's "New" column describes for a later phase once the
 * inspector's visuals are the thing being worked on.
 *
 * DP2 adds §6's inline validation ("end after start, no overlap") to the two time fields — the
 * only fields that can violate an invariant the rest of the app depends on — and D2's lock: a
 * locked block's (class, or a materialized routine block — `isLockedSlot`, lib/schedule.ts) times
 * aren't editable here either (matching TimeGrid's drag lock), and it can't be deleted here either
 * (Routine-Blocks spec D5) — a link takes you to edit the course/routine settings instead.
 */
export function BlockInspector({
  slot,
  allSlots,
  tasks,
  onChange,
  onDelete,
  autoFocusTitle = false
}: {
  slot: ScheduleSlot;
  /** Every block on this day, including `slot` itself — needed to check "no overlap" on a typed time edit. */
  allSlots: ScheduleSlot[];
  tasks: Task[];
  onChange: (slot: ScheduleSlot) => void;
  onDelete: () => void;
  /** Create → type → done (§4.3) — the parent should give this component `key={slot.id}` so a fresh selection remounts it and this one-time mount effect fires again. */
  autoFocusTitle?: boolean;
}) {
  const selectedTaskIds = new Set(slot.assignedTaskIds ?? []);
  const openTasks = tasks.filter((task) => task.status !== "done");
  const titleRef = useRef<HTMLInputElement>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const isLocked = isLockedSlot(slot);
  const isClass = slot.type === "class";

  useEffect(() => {
    if (autoFocusTitle) titleRef.current?.focus();
  }, []);

  function commitTime(field: "startTime" | "endTime", value: string): boolean {
    const candidate = { ...slot, [field]: value };
    const start = minutesFromTime(candidate.startTime);
    const end = minutesFromTime(candidate.endTime);
    if (end <= start) {
      setTimeError("End must be after start.");
      return false;
    }
    if (rangeOverlapsSlots(start, end, allSlots, slot.id)) {
      setTimeError("That overlaps another block.");
      return false;
    }
    setTimeError(null);
    onChange(candidate);
    return true;
  }

  return (
    <div className="space-y-3">
      {isLocked ? (
        <div className="flex items-center gap-2 rounded-md border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-2 text-xs text-fuchsia-800 dark:text-fuchsia-200">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{isClass ? "Class block — locked here." : "Routine block — locked here."}</span>
          <Link href={isClass ? "/courses" : "/settings/routine"} className="font-medium underline">
            {isClass ? "Edit course schedule" : "Edit in Settings"}
          </Link>
        </div>
      ) : null}
      <input
        ref={titleRef}
        className="input"
        value={slot.title}
        onChange={(event) => onChange({ ...slot, title: event.target.value })}
        placeholder="Block title"
      />
      <div className="grid grid-cols-2 gap-2">
        <TypedTimeInput value={slot.startTime} onChange={(startTime) => commitTime("startTime", startTime)} disabled={isLocked} />
        <TypedTimeInput value={slot.endTime} onChange={(endTime) => commitTime("endTime", endTime)} disabled={isLocked} />
      </div>
      {timeError ? <p className="text-xs text-red-600 dark:text-red-400">{timeError}</p> : null}
      <select className="input" value={slot.type} onChange={(event) => onChange({ ...slot, type: event.target.value as ScheduleSlotType })}>
        {slotTypes.map((type) => (
          <option key={type} value={type}>
            {slotTypeLabels[type]}
          </option>
        ))}
      </select>
      <MoreOptions>
        <div className="grid gap-3 lg:grid-cols-[1fr_180px]">
          <textarea
            className="input min-h-20"
            value={slot.note ?? ""}
            onChange={(event) => onChange({ ...slot, note: event.target.value })}
            placeholder="Optional note"
          />
          <select className="input" value={slot.status} onChange={(event) => onChange({ ...slot, status: event.target.value as ScheduleSlot["status"] })}>
            <option value="upcoming">Upcoming</option>
            <option value="completed">Completed</option>
            <option value="skipped">Skipped</option>
          </select>
        </div>
        <div>
          <p className="label mb-2">Assigned tasks</p>
          <div className="grid max-h-44 gap-2 overflow-auto rounded-md bg-ink-50 p-3 dark:bg-ink-800 sm:grid-cols-2">
            {openTasks.map((task) => (
              <label key={task.id} className="flex items-start gap-2 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={selectedTaskIds.has(task.id)}
                  onChange={(event) => {
                    const next = new Set(selectedTaskIds);
                    if (event.target.checked) next.add(task.id);
                    else next.delete(task.id);
                    onChange({ ...slot, assignedTaskIds: Array.from(next) });
                  }}
                />
                <span>{task.title}</span>
              </label>
            ))}
            {openTasks.length === 0 ? <p className="text-sm text-ink-500">No open tasks to assign.</p> : null}
          </div>
        </div>
      </MoreOptions>
      <Link
        href={`/dashboard?${new URLSearchParams({ startFocus: "1", label: slot.title, category: categoryForSlotType(slot.type), slotId: slot.id }).toString()}`}
        className="btn-secondary w-full py-1.5 text-xs"
      >
        <Play className="h-3.5 w-3.5" />
        Start focus session
      </Link>
      {!isLocked ? (
        <button className="btn-secondary w-full py-1.5 text-xs text-red-600" onClick={onDelete}>
          Delete block
        </button>
      ) : null}
    </div>
  );
}
