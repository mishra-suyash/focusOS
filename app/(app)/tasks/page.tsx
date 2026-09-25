"use client";

import { orderBy } from "firebase/firestore";
import { useMemo, useState } from "react";
import { EmptyState, focusSection } from "@/components/empty-state";
import { RecurringCommitmentForm } from "@/components/recurring-commitment-form";
import { RecurringCommitmentRow } from "@/components/recurring-commitment-row";
import { SectionHeader } from "@/components/section-header";
import { TaskForm } from "@/components/task-form";
import { TaskList } from "@/components/task-list";
import { TaskPackDialog } from "@/components/task-pack-dialog";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { categories, priorities, statuses } from "@/lib/options";
import { createRecurringTaskTemplate, createTask, deleteTask, updateTask } from "@/lib/firestore";
import { computeStatusPatch } from "@/lib/tasks";
import { todayKey, weekDates, weekStartKey } from "@/lib/dates";
import type { Category, Course, Priority, RecurringTaskTemplate, Task, TaskStatus } from "@/types";

export default function TasksPage() {
  const { user } = useAuth();
  const { items: tasks, loading: tasksLoading } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: recurringTemplates } = useUserCollection<RecurringTaskTemplate>("recurringTaskTemplates", useMemo(() => [orderBy("createdAt", "desc")], []));
  const [view, setView] = useState("all");
  const [category, setCategory] = useState<Category | "all">("all");
  const [priority, setPriority] = useState<Priority | "all">("all");
  const [status, setStatus] = useState<TaskStatus | "all">("all");
  const [courseId, setCourseId] = useState("all");
  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const today = todayKey();
  const week = weekStartKey();
  const weekEnd = weekDates(week)[6];

  const filtered = tasks.filter((task) => {
    const viewMatch =
      view === "all" ||
      (view === "today" && task.dueDate === today) ||
      // F6 (plan §11.2) — bounded to this Mon-Sun; anything past Sunday shows under "Upcoming" instead.
      (view === "week" && task.dueDate && task.dueDate >= week && task.dueDate <= weekEnd) ||
      (view === "upcoming" && task.dueDate && task.dueDate > weekEnd) ||
      (view === "completed" && task.status === "done");
    return (
      viewMatch &&
      (category === "all" || task.category === category) &&
      (priority === "all" || task.priority === priority) &&
      (status === "all" || task.status === status) &&
      (courseId === "all" || task.courseId === courseId)
    );
  });

  return (
    <>
      <SectionHeader title="Tasks" eyebrow="Capture, clarify, complete" />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <div className="space-y-6">
          <section id="task-quick-add" className="card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Quick add</h2>
              <button className="btn-secondary py-1.5 text-xs" onClick={() => setPackDialogOpen(true)}>Add from checklist</button>
            </div>
            <TaskForm onCreate={(task) => createTask(user!.uid, task)} courses={courses} />
          </section>
          <RecurringCommitmentsPanel courses={courses} templates={recurringTemplates} />
        </div>
        <section>
          <div className="card mb-4 p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <select className="input" value={view} onChange={(e) => setView(e.target.value)}>
                <option value="all">All</option>
                <option value="today">Today</option>
                <option value="week">This week</option>
                <option value="upcoming">Upcoming</option>
                <option value="completed">Completed</option>
              </select>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value as Category | "all")}>
                <option value="all">All categories</option>
                {categories.map((item) => <option key={item}>{item}</option>)}
              </select>
              <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority | "all")}>
                <option value="all">All priorities</option>
                {priorities.map((item) => <option key={item}>{item}</option>)}
              </select>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | "all")}>
                <option value="all">All statuses</option>
                {statuses.map((item) => <option key={item}>{item}</option>)}
              </select>
              {courses.length > 0 ? (
                <select className="input" value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                  <option value="all">All courses</option>
                  {courses.map((course) => (
                    <option key={course.id} value={course.id}>
                      {course.code ? `${course.code} · ${course.name}` : course.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
          {tasksLoading ? null : tasks.length === 0 ? (
            <EmptyState
              sentence="Everything you need to get done, research or not."
              primary={{ label: "Add a task", onClick: () => focusSection("task-quick-add") }}
              template={{ label: "Add from checklist", onClick: () => setPackDialogOpen(true) }}
            />
          ) : (
            <TaskList
              tasks={filtered}
              courses={courses}
              onStatus={(task, next) => updateTask(user!.uid, task.id, computeStatusPatch(task, next))}
              onDelete={(task) => deleteTask(user!.uid, task.id)}
            />
          )}
        </section>
      </div>
      {packDialogOpen ? <TaskPackDialog uid={user!.uid} onClose={() => setPackDialogOpen(false)} /> : null}
    </>
  );
}

/**
 * A recurring task no longer has to be added through a course card — "TA meets etc can be added
 * directly from tasks". Course-linking here is optional (the `courses` prop passed to
 * `RecurringCommitmentForm` renders its own picker); leaving it unset makes a template that's a
 * personal routine, not tied to any course. Lists every template the user has, not just the
 * course-linked ones, so this doubles as the one place to see all of them at a glance.
 */
/** plan/14 §8 — the standalone "Generate now" button that used to sit here is gone: the daily cron
 *  and the weekly planner (`/plan/week` Step 4) both already cover generation, so a manual trigger
 *  has nothing left to reveal that the weekly session doesn't already show. */
function RecurringCommitmentsPanel({ courses, templates }: { courses: Course[]; templates: RecurringTaskTemplate[] }) {
  const { user } = useAuth();

  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Recurring commitments</h2>
      </div>
      <div className="mb-3 space-y-2">
        {templates.map((tmpl) => (
          <RecurringCommitmentRow key={tmpl.id} uid={user!.uid} template={tmpl} courseName={courses.find((c) => c.id === tmpl.courseId)?.name} />
        ))}
        {templates.length === 0 ? (
          <p className="text-sm text-ink-500">No recurring commitments yet — a TA meeting, office hours, or a problem set due every week.</p>
        ) : null}
      </div>
      <RecurringCommitmentForm courses={courses} onCreate={(tmpl) => createRecurringTaskTemplate(user!.uid, tmpl)} />
    </section>
  );
}
