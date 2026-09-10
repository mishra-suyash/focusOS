"use client";

import { orderBy } from "firebase/firestore";
import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { TaskForm } from "@/components/task-form";
import { TaskList } from "@/components/task-list";
import { TaskPackDialog } from "@/components/task-pack-dialog";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { categories, priorities, statuses } from "@/lib/options";
import { createTask, deleteTask, updateTask } from "@/lib/firestore";
import { todayKey, weekStartKey } from "@/lib/dates";
import type { Category, Priority, Task, TaskStatus } from "@/types";

export default function TasksPage() {
  const { user } = useAuth();
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const [view, setView] = useState("inbox");
  const [category, setCategory] = useState<Category | "all">("all");
  const [priority, setPriority] = useState<Priority | "all">("all");
  const [status, setStatus] = useState<TaskStatus | "all">("all");
  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const today = todayKey();
  const week = weekStartKey();

  const filtered = tasks.filter((task) => {
    const viewMatch =
      view === "inbox" ||
      (view === "today" && task.dueDate === today) ||
      (view === "week" && task.dueDate && task.dueDate >= week) ||
      (view === "completed" && task.status === "done");
    return viewMatch && (category === "all" || task.category === category) && (priority === "all" || task.priority === priority) && (status === "all" || task.status === status);
  });

  return (
    <>
      <SectionHeader title="Tasks" eyebrow="Capture, clarify, complete" />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <section className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Quick add</h2>
            <button className="btn-secondary py-1.5 text-xs" onClick={() => setPackDialogOpen(true)}>Add from checklist</button>
          </div>
          <TaskForm onCreate={(task) => createTask(user!.uid, task)} />
        </section>
        <section>
          <div className="card mb-4 p-4">
            <div className="grid gap-3 md:grid-cols-4">
              <select className="input" value={view} onChange={(e) => setView(e.target.value)}>
                <option value="inbox">Inbox</option>
                <option value="today">Today</option>
                <option value="week">This week</option>
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
            </div>
          </div>
          <TaskList
            tasks={filtered}
            onStatus={(task, next) => updateTask(user!.uid, task.id, { status: next, completedAt: next === "done" ? new Date().toISOString() : undefined })}
            onDelete={(task) => deleteTask(user!.uid, task.id)}
          />
        </section>
      </div>
      {packDialogOpen ? <TaskPackDialog uid={user!.uid} onClose={() => setPackDialogOpen(false)} /> : null}
    </>
  );
}
