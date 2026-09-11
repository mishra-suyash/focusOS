"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import { useUserSettings } from "@/hooks/use-user-settings";
import type { Course, Day, Goal, Paper, PomodoroSession, Task } from "@/types";

export interface ChecklistData {
  tasks: Task[];
  sessions: PomodoroSession[];
  papers: Paper[];
  courses: Course[];
  goals: Goal[];
  recentDays: Day[];
}

/** The getting-started checklist (plan §8.3) — items auto-check from real data already loaded on Today; only the dismissed state is stored, nothing else is persisted per-item. */
export function GettingStartedChecklist({ data }: { data: ChecklistData }) {
  const { user } = useAuth();
  const { settings, loaded, update } = useUserSettings();
  const [collapsed, setCollapsed] = useState(false);

  const status = settings.onboarding?.status;
  const onboardingResolved = status === "done" || status === "skipped";
  // Never renders mid-flow — dismissing here must not be able to stamp `status` before the
  // stepper itself has set it (that would mark onboarding done with no pack/template/timer ever chosen).
  if (!user || !loaded || !onboardingResolved || settings.onboarding?.checklistDismissed) return null;

  const pack = settings.packId;
  const items: { label: string; done: boolean }[] = [
    { label: "Add a task", done: data.tasks.length > 0 },
    { label: "Start your day", done: data.recentDays.some((day) => Boolean(day.session?.startedAt)) },
    { label: "Finish one focus session", done: data.sessions.some((session) => session.mode === "work") },
    { label: extraItemLabel(pack), done: extraItemDone(pack, data) },
    { label: "Wrap up your day", done: data.recentDays.some((day) => Boolean(day.review?.submittedAt)) }
  ];
  const doneCount = items.filter((item) => item.done).length;
  const allDone = doneCount === items.length;

  function dismiss() {
    // `settings.onboarding` is guaranteed defined and resolved here (the render guard above),
    // so this only ever adds `checklistDismissed` — it can't stamp a status onboarding itself hasn't set.
    update({ onboarding: { ...settings.onboarding!, checklistDismissed: true } });
  }

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-2 text-sm font-semibold" onClick={() => setCollapsed((current) => !current)}>
          {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          Getting started {doneCount}/{items.length}
        </button>
        <button className="text-ink-400 hover:text-ink-600 dark:hover:text-ink-200" onClick={dismiss} aria-label="Dismiss getting-started checklist">
          <X className="h-4 w-4" />
        </button>
      </div>
      {!collapsed ? (
        <div className="mt-3 space-y-1.5">
          {items.map((item) => (
            <div key={item.label} className="flex items-center gap-2 text-sm">
              <span className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${item.done ? "border-moss-600 bg-moss-600 text-white" : "border-ink-300 dark:border-ink-700"}`}>
                {item.done ? "✓" : ""}
              </span>
              <span className={item.done ? "text-ink-400 line-through" : ""}>{item.label}</span>
            </div>
          ))}
          {allDone ? (
            <Link href="/settings/features" className="mt-2 inline-block text-xs font-medium text-moss-700 dark:text-moss-400">
              Discover more features
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function extraItemLabel(pack?: string) {
  if (pack === "coursework") return "Add your first course";
  if (pack === "writing") return "Create a thesis goal";
  if (pack === "research" || pack === "everything") return "Skim a paper";
  return "Add a paper to your reading list";
}

function extraItemDone(pack: string | undefined, data: ChecklistData) {
  if (pack === "coursework") return data.courses.length > 0;
  if (pack === "writing") return data.goals.length > 0;
  if (pack === "research" || pack === "everything") return data.papers.some((paper) => paper.pass1?.status === "done");
  return data.papers.length > 0;
}
