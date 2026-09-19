"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { dayOfWeekLabels } from "@/lib/courses";
import { deleteRecurringTaskTemplate, updateRecurringTaskTemplate } from "@/lib/firestore";
import type { RecurringTaskTemplate } from "@/types";

/**
 * plan/FocusOS-v2-Connected-Flow-Plan.md §4.5 — editing title/category/priority only reshapes
 * future generations (there's nothing here to edit those in place); "Active"/"Paused" and delete
 * are the only controls a hand-added template needs. Shared between the course card's own
 * "Recurring commitments" list and the Tasks page's page-wide one, since a template no longer has
 * to be tied to a course.
 *
 * A template with `generatedFrom: "courseRevisionTarget"` is managed automatically by the course's
 * revision-hours field (`lib/recurring-tasks.ts`'s `planRevisionTemplateSync`) — its delete button
 * is hidden so deleting it here can't silently get undone the next time that field changes; pausing
 * still works since a manual pause is respected by the sync.
 */
export function RecurringCommitmentRow({ uid, template, courseName }: { uid: string; template: RecurringTaskTemplate; courseName?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const days = template.daysOfWeek.map((day) => dayOfWeekLabels[day].slice(0, 3)).join(", ");
  const isAutoRevision = template.generatedFrom === "courseRevisionTarget";

  async function toggleActive() {
    setBusy(true);
    setError("");
    try {
      await updateRecurringTaskTemplate(uid, template.id, { active: !template.active });
    } catch {
      setError("Couldn't save that change — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await deleteRecurringTaskTemplate(uid, template.id);
    } catch {
      setError("Couldn't delete this — try again.");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={template.active ? "" : "text-ink-400 line-through"}>{template.title}</span>
            {isAutoRevision ? (
              <span className="rounded bg-ink-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ink-500 dark:bg-ink-800">Auto</span>
            ) : null}
            {courseName ? <span className="rounded bg-ink-50 px-1.5 py-0.5 text-[10px] text-ink-500 dark:bg-ink-800">{courseName}</span> : null}
          </div>
          <p className="text-xs text-ink-500">
            {days} · {template.cadence === "biweekly" ? "every 2 weeks" : "every week"}
            {template.time ? ` · ${template.time.startTime}–${template.time.endTime}` : ""}
            {template.time?.location ? ` · ${template.time.location}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary py-1 text-xs" onClick={toggleActive} disabled={busy}>
            {template.active ? "Pause" : "Resume"}
          </button>
          {isAutoRevision ? (
            <span className="text-xs text-ink-400" title="Managed by this course's revision hours/week — clear the hours to stop it.">
              Clear hours to stop
            </span>
          ) : (
            <button className="text-ink-400 hover:text-red-600 disabled:opacity-50" onClick={remove} disabled={busy} aria-label="Delete recurring commitment">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
