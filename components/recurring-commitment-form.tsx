"use client";

import { useState } from "react";
import { MoreOptions } from "@/components/more-options";
import { dayOfWeekLabels } from "@/lib/courses";
import { todayKey } from "@/lib/dates";
import { categories, priorities } from "@/lib/options";
import { clsx } from "clsx";
import type { Category, Course, NewRecurringTaskTemplate, Priority, RecurrenceCadence } from "@/types";

/**
 * plan/FocusOS-v2-Connected-Flow-Plan.md §5.1 — a TA meeting, office hours, or "grade problem
 * sets due every Friday", configured once on the course. Title + day(s) + cadence always visible
 * (the minimum to describe "when"); everything else behind "More options", same split TaskForm
 * and PaperForm already use.
 *
 * `courseStartDate`/`courseEndDate` are how the course card's own usage (always scoped to one
 * course) supplies bounds. Pass `courses` instead for a course-agnostic usage (the Tasks page) —
 * it renders its own optional course picker and derives startDate/endDate/courseId from whichever
 * course gets picked there, falling back to the two date props when none is selected.
 */
export function RecurringCommitmentForm({
  courseStartDate,
  courseEndDate,
  courses,
  onCreate
}: {
  courseStartDate?: string;
  courseEndDate?: string;
  courses?: Course[];
  onCreate: (template: NewRecurringTaskTemplate) => Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [courseId, setCourseId] = useState("");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [cadence, setCadence] = useState<RecurrenceCadence>("weekly");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState<Category>("admin");
  const [priority, setPriority] = useState<Priority>("medium");
  const [estimatedPomodoros, setEstimatedPomodoros] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  function toggleDay(day: number) {
    setDaysOfWeek((current) => (current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort()));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || daysOfWeek.length === 0) return;
    setSaving(true);
    const selectedCourse = courses?.find((item) => item.id === courseId);
    await onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      category,
      priority,
      estimatedPomodoros: estimatedPomodoros ? Number(estimatedPomodoros) : undefined,
      cadence,
      daysOfWeek,
      // §3.2 — required for biweekly, set once at creation time so it's never left unset.
      anchorDate: cadence === "biweekly" ? todayKey() : undefined,
      time: startTime && endTime ? { startTime, endTime, location: location.trim() || undefined } : undefined,
      active: true,
      courseId: courses ? selectedCourse?.id : undefined,
      startDate: selectedCourse?.startDate ?? courseStartDate,
      endDate: selectedCourse?.endDate ?? courseEndDate
    });
    setTitle("");
    setCourseId("");
    setDaysOfWeek([]);
    setStartTime("");
    setEndTime("");
    setLocation("");
    setDescription("");
    setEstimatedPomodoros("");
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_130px_auto]">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="TA office hours, grade problem sets…" />
        <select className="input" value={cadence} onChange={(e) => setCadence(e.target.value as RecurrenceCadence)}>
          <option value="weekly">Every week</option>
          <option value="biweekly">Every 2 weeks</option>
        </select>
        <button className="btn-secondary" disabled={saving || !title.trim() || daysOfWeek.length === 0}>
          Add
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {dayOfWeekLabels.map((label, day) => (
          <button
            key={label}
            type="button"
            className={clsx("btn-secondary px-2 py-1 text-xs", daysOfWeek.includes(day) && "bg-moss-600/10 text-moss-700 dark:text-moss-400")}
            onClick={() => toggleDay(day)}
          >
            {label.slice(0, 3)}
          </button>
        ))}
      </div>
      <MoreOptions>
        {courses ? (
          <select className="input" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">No course</option>
            {courses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code ? `${item.code} · ${item.name}` : item.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-3">
          <input className="input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} aria-label="Start time (optional)" />
          <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} aria-label="End time (optional)" />
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" />
        </div>
        <textarea
          className="input min-h-16"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description, context, or what a generated task should remind you of"
        />
        <div className="grid gap-2 sm:grid-cols-3">
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
          <input
            className="input"
            type="number"
            min={1}
            max={12}
            value={estimatedPomodoros}
            onChange={(e) => setEstimatedPomodoros(e.target.value)}
            placeholder="Focus sessions"
            aria-label="Estimated focus sessions"
          />
        </div>
      </MoreOptions>
    </form>
  );
}
