"use client";

import { useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { MoreOptions } from "@/components/more-options";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { categories, categoryLabels, priorities, taskBuckets, taskBucketLabels } from "@/lib/options";
import type { Category, Course, NewTask, Priority, TaskBucket } from "@/types";

const DEFAULT_EXTERNAL_LEAD_DAYS = [7, 2, 0];

/** Plan §9.5 — Title and due date (Today / Tomorrow / Pick) always visible; everything else behind "More options". */
export function TaskForm({
  onCreate,
  compact = false,
  courses = []
}: {
  onCreate: (task: NewTask) => Promise<unknown>;
  compact?: boolean;
  /** plan/10.FocusOS-v2-Connected-Flow-Plan.md §5.2 — the course picker only renders when there's at least one course to pick, matching how the whole Courses module is already optional. */
  courses?: Course[];
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("research");
  const [priority, setPriority] = useState<Priority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [estimatedPomodoros, setEstimatedPomodoros] = useState(1);
  const [external, setExternal] = useState(false);
  const [courseId, setCourseId] = useState("");
  const [bucket, setBucket] = useState<TaskBucket | "">("");
  const [saving, setSaving] = useState(false);

  const today = todayKey();
  const tomorrow = addDaysToKey(today, 1);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    if (external && !dueDate) return;
    setSaving(true);
    await onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      status: "todo",
      priority,
      category,
      dueDate: dueDate || undefined,
      estimatedPomodoros,
      kind: external ? "external" : undefined,
      reminderLeadDays: external ? DEFAULT_EXTERNAL_LEAD_DAYS : undefined,
      courseId: courseId || undefined,
      bucket: courseId && bucket ? bucket : undefined
    });
    setTitle("");
    setDescription("");
    setDueDate("");
    setEstimatedPomodoros(1);
    setExternal(false);
    setCourseId("");
    setBucket("");
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a research task..." />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={`btn-secondary py-1.5 text-xs ${dueDate === today ? "bg-moss-600/10" : ""}`} onClick={() => setDueDate(today)}>
          Today
        </button>
        <button type="button" className={`btn-secondary py-1.5 text-xs ${dueDate === tomorrow ? "bg-moss-600/10" : ""}`} onClick={() => setDueDate(tomorrow)}>
          Tomorrow
        </button>
        <input className="input flex-1" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      {!compact ? (
        <MoreOptions>
          <textarea
            className="input min-h-20"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description, context, or next physical action"
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {categoryLabels[item]}
                </option>
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
              onChange={(e) => setEstimatedPomodoros(Number(e.target.value))}
              aria-label="Estimated focus sessions"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
            <input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} />
            Hard deadline (visa renewal, a form, a submission portal — excluded from Workload&apos;s planned target)
          </label>
          {courses.length > 0 ? (
            <select
              className="input"
              value={courseId}
              onChange={(e) => {
                const nextCourseId = e.target.value;
                setCourseId(nextCourseId);
                // Only default the bucket the moment a course is first picked (empty -> a course).
                // Switching between two already-selected courses, or clearing back to no course,
                // preserves whatever bucket the user already chose instead of silently overwriting it.
                if (!courseId && nextCourseId) setBucket("assignment");
              }}
              aria-label="Course"
            >
              <option value="">— No course —</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code ? `${course.code} · ${course.name}` : course.name}
                </option>
              ))}
            </select>
          ) : null}
          {courseId ? (
            <label className="text-xs text-ink-500">
              <span className="inline-flex items-center gap-1">
                Weekly bucket
                <InfoHint term="weeklyBucket" />
              </span>
              <select className="input mt-1" value={bucket} onChange={(e) => setBucket(e.target.value as TaskBucket)} aria-label="Weekly bucket">
                {taskBuckets.map((item) => (
                  <option key={item} value={item}>
                    {taskBucketLabels[item]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </MoreOptions>
      ) : null}
      <button className="btn-primary w-full sm:w-auto" disabled={saving || (external && !dueDate)}>
        Add task
      </button>
    </form>
  );
}
