"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { dayOfWeekLabels } from "@/lib/courses";
import type { CourseSession, NewCourse, Term } from "@/types";

function newSession(): CourseSession {
  return { id: crypto.randomUUID(), dayOfWeek: 1, startTime: "09:00", endTime: "10:30" };
}

export function CourseForm({ terms, onCreate }: { terms: Term[]; onCreate: (course: NewCourse) => Promise<void> }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [instructor, setInstructor] = useState("");
  const [termId, setTermId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [targetMinutesPerWeek, setTargetMinutesPerWeek] = useState("");
  const [sessions, setSessions] = useState<CourseSession[]>([newSession()]);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const term = terms.find((item) => item.id === termId);
    await onCreate({
      name: name.trim(),
      code: code.trim() || undefined,
      instructor: instructor.trim() || undefined,
      termId: termId || undefined,
      status: "active",
      startDate: startDate || term?.startDate,
      endDate: endDate || term?.endDate,
      targetMinutesPerWeek: targetMinutesPerWeek ? Number(targetMinutesPerWeek) : undefined,
      sessions
    });
    setName("");
    setCode("");
    setInstructor("");
    setStartDate("");
    setEndDate("");
    setTargetMinutesPerWeek("");
    setSessions([newSession()]);
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Course name" />
      <div className="grid gap-3 sm:grid-cols-2">
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code (e.g. CS 701)" />
        <input className="input" value={instructor} onChange={(e) => setInstructor(e.target.value)} placeholder="Instructor" />
      </div>
      <select className="input" value={termId} onChange={(e) => setTermId(e.target.value)}>
        <option value="">No term (always active)</option>
        {terms.map((term) => (
          <option key={term.id} value={term.id}>
            {term.name}
          </option>
        ))}
      </select>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-ink-500">
          Start date (optional)
          <input className="input mt-1" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="Defaults to term start" />
        </label>
        <label className="text-xs text-ink-500">
          End date (optional)
          <input className="input mt-1" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="Defaults to term end" />
        </label>
        <label className="text-xs text-ink-500">
          Target min/week
          <input className="input mt-1" type="number" min={0} value={targetMinutesPerWeek} onChange={(e) => setTargetMinutesPerWeek(e.target.value)} />
        </label>
      </div>
      <div className="space-y-2">
        <p className="label">Weekly sessions</p>
        {sessions.map((session, index) => (
          <div key={session.id} className="grid grid-cols-[1fr_100px_100px_auto] items-center gap-2">
            <select
              className="input"
              value={session.dayOfWeek}
              onChange={(e) =>
                setSessions((items) => items.map((item, i) => (i === index ? { ...item, dayOfWeek: Number(e.target.value) } : item)))
              }
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
        <button type="button" className="btn-secondary py-1.5 text-xs" onClick={() => setSessions((items) => [...items, newSession()])}>
          <Plus className="h-3.5 w-3.5" />
          Add session
        </button>
      </div>
      <button className="btn-primary w-full sm:w-auto" disabled={saving}>
        Add course
      </button>
    </form>
  );
}
