"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { createTasksBatch } from "@/lib/firestore";
import { BUILTIN_TASK_PACKS } from "@/lib/templates/builtin/task-packs";
import type { NewTask } from "@/types";

/** "Add from checklist" (plan §6.3) — picks a built-in task pack and an anchor date, creates every task in one batch with due dates offset from that anchor. */
export function TaskPackDialog({ uid, onClose }: { uid: string; onClose: () => void }) {
  const [packId, setPackId] = useState(BUILTIN_TASK_PACKS[0].id);
  const [anchorDate, setAnchorDate] = useState(todayKey());
  const [saving, setSaving] = useState(false);
  const pack = BUILTIN_TASK_PACKS.find((item) => item.id === packId)!;

  async function apply() {
    setSaving(true);
    try {
      const tasks: NewTask[] = pack.tasks.map((item) => ({
        title: item.title,
        status: "todo",
        priority: item.priority,
        category: item.category,
        kind: item.kind,
        dueDate: typeof item.dueOffsetDays === "number" ? addDaysToKey(anchorDate, item.dueOffsetDays) : undefined
      }));
      await createTasksBatch(uid, tasks);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-10 sm:pt-16" onClick={onClose}>
      <div className="card w-full max-w-lg p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">Add from checklist</h2>
          <button className="btn-secondary px-2 py-1.5" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <label className="mb-3 block text-sm">
          <span className="label mb-1 block">Checklist</span>
          <select className="input" value={packId} onChange={(event) => setPackId(event.target.value)}>
            {BUILTIN_TASK_PACKS.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <p className="mb-3 text-sm text-ink-500">{pack.description}</p>
        <label className="mb-4 block text-sm">
          <span className="label mb-1 block">{pack.anchorLabel}</span>
          <input className="input" type="date" value={anchorDate} onChange={(event) => setAnchorDate(event.target.value)} />
        </label>
        <div className="mb-4 max-h-56 space-y-1.5 overflow-auto rounded-md bg-ink-50 p-3 text-xs dark:bg-ink-800">
          {pack.tasks.map((item, index) => (
            <div key={index} className="flex justify-between gap-2">
              <span>{item.title}</span>
              <span className="whitespace-nowrap text-ink-500">
                {typeof item.dueOffsetDays === "number" ? addDaysToKey(anchorDate, item.dueOffsetDays) : "no due date"}
              </span>
            </div>
          ))}
        </div>
        <button className="btn-primary w-full" onClick={apply} disabled={saving}>
          {saving ? "Adding..." : `Add ${pack.tasks.length} tasks`}
        </button>
      </div>
    </div>
  );
}
