"use client";

import { Plus, Trash2 } from "lucide-react";
import { useUserSettings } from "@/hooks/use-user-settings";
import { minutesFromTime } from "@/lib/schedule";
import type { UserSettings } from "@/types";

type Range = { startTime: string; endTime: string };
type Shape = NonNullable<UserSettings["dayShape"]>;

const SUGGESTED: Shape = { deep: [{ startTime: "05:30", endTime: "13:00" }], light: [{ startTime: "13:45", endTime: "18:00" }] };

/** The problem with a set of windows, or null: each must end after it starts, and none may overlap. */
function shapeProblem(shape: Shape): string | null {
  const all = [...shape.deep, ...shape.light].map((range) => ({ ...range, s: minutesFromTime(range.startTime), e: minutesFromTime(range.endTime) }));
  const inverted = all.find((range) => range.e <= range.s);
  if (inverted) return `${inverted.startTime}–${inverted.endTime} ends before it starts.`;
  const sorted = [...all].sort((a, b) => a.s - b.s);
  const overlap = sorted.find((range, i) => i > 0 && range.s < sorted[i - 1].e);
  return overlap ? `${overlap.startTime}–${overlap.endTime} overlaps another window.` : null;
}

/**
 * The shape of a working day (`UserSettings.dayShape`): deep windows for deep work and reading, light
 * windows for admin and revision, nothing outside them. Read by the weekly planner's placement, by Up
 * next, and by Claude's block writes (lib/weekplan.ts `dayShapeWindows`).
 */
export function DayShapeSettings() {
  const { settings, update } = useUserSettings();
  const shape = settings.dayShape;
  const problem = shape ? shapeProblem(shape) : null;

  function setRanges(kind: keyof Shape, ranges: Range[]) {
    if (!shape) return;
    update({ dayShape: { ...shape, [kind]: ranges } });
  }

  function rangeRows(kind: keyof Shape, label: string) {
    if (!shape) return null;
    const ranges = shape[kind];
    return (
      <div>
        <p className="label mb-1">{label}</p>
        <div className="space-y-2">
          {ranges.map((range, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2 text-sm">
              <input
                className="input w-28 py-1"
                type="time"
                value={range.startTime}
                aria-label={`${label} window ${index + 1} start`}
                onChange={(e) => setRanges(kind, ranges.map((item, i) => (i === index ? { ...item, startTime: e.target.value } : item)))}
              />
              <span className="text-ink-500">to</span>
              <input
                className="input w-28 py-1"
                type="time"
                value={range.endTime}
                aria-label={`${label} window ${index + 1} end`}
                onChange={(e) => setRanges(kind, ranges.map((item, i) => (i === index ? { ...item, endTime: e.target.value } : item)))}
              />
              <button type="button" className="text-ink-400 hover:text-red-600" aria-label={`Remove ${label.toLowerCase()} window ${index + 1}`} onClick={() => setRanges(kind, ranges.filter((_, i) => i !== index))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {ranges.length < 4 ? (
            <button type="button" className="btn-secondary py-1 text-xs" onClick={() => setRanges(kind, [...ranges, { startTime: "09:00", endTime: "10:00" }])}>
              <Plus className="h-3 w-3" />
              Add {label.toLowerCase()} window
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section className="card p-5">
      <h2 className="mb-4 text-lg font-semibold">Shape of the day</h2>
      <p className="mb-3 text-xs text-ink-500">
        When you do deep work and when only light work. Weekly planning puts deep work and reading only in deep windows, and admin
        and revision in light windows first. Up next suggests nothing outside the windows. Blocks already on a day aren&apos;t moved.
      </p>
      <label className="mb-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={Boolean(shape)} onChange={(e) => update({ dayShape: e.target.checked ? SUGGESTED : undefined })} />
        Plan around a day shape
      </label>
      {shape ? (
        <div className="space-y-3">
          {rangeRows("deep", "Deep work")}
          {rangeRows("light", "Light work")}
          {problem ? <p className="text-xs text-amber-700 dark:text-amber-400">{problem} Planning uses the windows as they are until this is fixed.</p> : null}
          <p className="text-xs text-ink-500">No work is planned outside these windows, for example after the gym.</p>
        </div>
      ) : null}
    </section>
  );
}
