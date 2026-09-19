"use client";

import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { SectionHeader } from "@/components/section-header";
import { TypedTimeInput } from "@/components/plan/typed-time-input";
import { useUserSettings } from "@/hooks/use-user-settings";
import { DEFAULT_ROUTINE_BLOCKS } from "@/lib/routine";
import { slotTypeLabels, slotTypes } from "@/lib/schedule";
import type { RoutineBlock, ScheduleSlotType } from "@/types";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BUILTIN_IDS = new Set(DEFAULT_ROUTINE_BLOCKS.map((block) => block.id));
// A routine block materializes as a locked slot alongside class blocks — "class" is reserved for
// what `courseSlotsForDate` actually generates, so it's excluded here to avoid a routine block
// that's indistinguishable from (and easily confused with) a real course meeting.
const ROUTINE_SLOT_TYPES = slotTypes.filter((type) => type !== "class");

/**
 * plan/07.FocusOS-v2-Routine-Blocks-and-AI-Templates.md §2.6 — Sleep/meals/Gym/custom recurring
 * anchors, configured once here instead of re-typed into every template. Whichever are enabled
 * show up locked on every matching day (`lib/routine.ts`'s `routineSlotsForDate`, wired into
 * `/plan/day` and `WorkdaySessionProvider.start()`).
 */
export default function RoutineSettingsPage() {
  const { settings, update } = useUserSettings();
  const blocks = settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS;

  function patch(id: string, changes: Partial<RoutineBlock>) {
    update({ routineBlocks: blocks.map((block) => (block.id === id ? { ...block, ...changes } : block)) });
  }

  function toggleDay(block: RoutineBlock, day: number) {
    const current = block.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort();
    patch(block.id, { daysOfWeek: next.length === 7 ? undefined : next });
  }

  function addCustom() {
    const block: RoutineBlock = { id: crypto.randomUUID(), label: "New block", type: "custom", startTime: "09:00", endTime: "09:30", enabled: true };
    update({ routineBlocks: [...blocks, block] });
  }

  function removeCustom(id: string) {
    update({ routineBlocks: blocks.filter((block) => block.id !== id) });
  }

  return (
    <>
      <SectionHeader title="Routine" eyebrow="Recurring blocks">
        <Link href="/settings" className="btn-secondary py-1.5 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" />
          Settings
        </Link>
      </SectionHeader>
      <p className="mb-4 text-sm text-ink-500">
        Sleep, meals, gym, or anything else recurring. Whichever are on appear locked on every matching day in Plan — Day — a
        template applied on top never displaces them.
      </p>
      <div className="card divide-y divide-ink-100 dark:divide-ink-800">
        {blocks.map((block) => (
          <div key={block.id} className="space-y-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-40" value={block.label} onChange={(event) => patch(block.id, { label: event.target.value })} />
              <select
                className="input w-36"
                value={block.type}
                onChange={(event) => patch(block.id, { type: event.target.value as ScheduleSlotType })}
              >
                {ROUTINE_SLOT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {slotTypeLabels[type]}
                  </option>
                ))}
              </select>
              <TypedTimeInput className="input w-24" value={block.startTime} onChange={(time) => patch(block.id, { startTime: time })} />
              <span className="text-sm text-ink-500">to</span>
              <TypedTimeInput className="input w-24" value={block.endTime} onChange={(time) => patch(block.id, { endTime: time })} />
              <label className="ml-auto flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={block.enabled} onChange={(event) => patch(block.id, { enabled: event.target.checked })} />
                Enabled
              </label>
              {!BUILTIN_IDS.has(block.id) ? (
                <button className="btn-secondary px-2 py-1.5" onClick={() => removeCustom(block.id)} aria-label={`Delete ${block.label}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1">
              {DAY_LABELS.map((label, day) => {
                const active = !block.daysOfWeek || block.daysOfWeek.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    className={`rounded px-2 py-1 text-xs font-medium ${
                      active ? "bg-moss-600/15 text-moss-700 dark:text-moss-400" : "bg-ink-100 text-ink-400 dark:bg-ink-800"
                    }`}
                    onClick={() => toggleDay(block, day)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button className="btn-secondary mt-4 py-1.5 text-xs" onClick={addCustom}>
        <Plus className="h-3.5 w-3.5" />
        Add custom recurring block
      </button>
    </>
  );
}
