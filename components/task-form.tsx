"use client";

import { useState } from "react";
import { categories, priorities } from "@/lib/options";
import type { Category, NewTask, Priority } from "@/types";

export function TaskForm({ onCreate, compact = false }: { onCreate: (task: NewTask) => Promise<void>; compact?: boolean }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("research");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [estimatedPomodoros, setEstimatedPomodoros] = useState(1);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      status: "todo",
      priority,
      category,
      dueDate: dueDate || undefined,
      estimatedPomodoros
    });
    setTitle("");
    setDescription("");
    setDueDate("");
    setEstimatedPomodoros(1);
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a research task..." />
      {!compact ? (
        <textarea
          className="input min-h-20"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description, context, or next physical action"
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-4">
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {categories.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          {priorities.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <input
          className="input"
          type="number"
          min={1}
          max={12}
          value={estimatedPomodoros}
          onChange={(e) => setEstimatedPomodoros(Number(e.target.value))}
          aria-label="Estimated pomodoros"
        />
      </div>
      <button className="btn-primary w-full sm:w-auto" disabled={saving}>
        Add task
      </button>
    </form>
  );
}
