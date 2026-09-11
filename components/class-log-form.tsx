"use client";

import { useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { todayKey } from "@/lib/dates";
import type { ClassAttendance } from "@/types";
import type { ClassLogInput } from "@/lib/classlog";

const ATTENDANCE_OPTIONS: { value: ClassAttendance; label: string }[] = [
  { value: "attended", label: "Attended" },
  { value: "missed", label: "Missed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "self_study", label: "Self-study" }
];

export function ClassLogForm({ onSave }: { onSave: (input: ClassLogInput) => Promise<void> }) {
  const [date, setDate] = useState(todayKey());
  const [attendance, setAttendance] = useState<ClassAttendance>("attended");
  const [rawTopics, setRawTopics] = useState("");
  const [understanding, setUnderstanding] = useState(3);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const needsTopics = attendance !== "cancelled";
  const ratesUnderstanding = attendance === "attended" || attendance === "self_study";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({
        date,
        attendance,
        rawTopics: needsTopics ? rawTopics : undefined,
        understanding: ratesUnderstanding ? understanding : undefined,
        notes: notes || undefined
      });
      setRawTopics("");
      setNotes("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <div className="grid grid-cols-2 gap-2">
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select className="input" value={attendance} onChange={(e) => setAttendance(e.target.value as ClassAttendance)}>
          {ATTENDANCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {needsTopics ? (
        <textarea
          className="input min-h-16"
          value={rawTopics}
          onChange={(e) => setRawTopics(e.target.value)}
          placeholder={attendance === "missed" ? "What did you miss, if you know? One per line/comma." : "Topics covered — one per line, comma, or semicolon."}
        />
      ) : null}
      {ratesUnderstanding ? (
        <label className="block text-xs text-ink-500">
          <span className="inline-flex items-center gap-1">
            Understanding: {understanding}
            <InfoHint term="understanding" />
          </span>
          <input
            className="mt-1 w-full accent-moss-600"
            type="range"
            min={1}
            max={5}
            value={understanding}
            onChange={(e) => setUnderstanding(Number(e.target.value))}
          />
        </label>
      ) : null}
      <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" />
      <button className="btn-primary py-1.5 text-xs" disabled={saving}>
        {saving ? "Saving..." : "Save log"}
      </button>
    </form>
  );
}
