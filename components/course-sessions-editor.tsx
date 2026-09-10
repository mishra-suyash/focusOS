"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { dayOfWeekLabels } from "@/lib/courses";
import type { CourseSession } from "@/types";

function newSession(): CourseSession {
  return { id: crypto.randomUUID(), dayOfWeek: 1, startTime: "09:00", endTime: "10:30" };
}

export function CourseSessionsEditor({
  initialSessions,
  onSave,
  onCancel
}: {
  initialSessions: CourseSession[];
  onSave: (sessions: CourseSession[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [sessions, setSessions] = useState<CourseSession[]>(initialSessions.length > 0 ? initialSessions : [newSession()]);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await onSave(sessions);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-dashed border-ink-300 p-3 dark:border-ink-700">
      {sessions.map((session, index) => (
        <div key={session.id} className="grid grid-cols-[1fr_100px_100px_auto] items-center gap-2">
          <select
            className="input"
            value={session.dayOfWeek}
            onChange={(e) => setSessions((items) => items.map((item, i) => (i === index ? { ...item, dayOfWeek: Number(e.target.value) } : item)))}
          >
            {dayOfWeekLabels.map((label, day) => (
              <option key={label} value={day}>
                {label}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="time"
            value={session.startTime}
            onChange={(e) => setSessions((items) => items.map((item, i) => (i === index ? { ...item, startTime: e.target.value } : item)))}
          />
          <input
            className="input"
            type="time"
            value={session.endTime}
            onChange={(e) => setSessions((items) => items.map((item, i) => (i === index ? { ...item, endTime: e.target.value } : item)))}
          />
          <button
            type="button"
            className="btn-secondary px-2 py-1.5"
            onClick={() => setSessions((items) => items.filter((_, i) => i !== index))}
            aria-label="Remove session"
            disabled={sessions.length === 1}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn-secondary py-1.5 text-xs" onClick={() => setSessions((items) => [...items, newSession()])}>
          <Plus className="h-3.5 w-3.5" />
          Add session
        </button>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary py-1.5 text-xs" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-primary py-1.5 text-xs" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save sessions"}
          </button>
        </div>
      </div>
    </div>
  );
}
