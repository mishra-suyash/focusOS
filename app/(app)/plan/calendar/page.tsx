"use client";

import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths
} from "date-fns";
import { orderBy } from "firebase/firestore";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useUserSettings } from "@/hooks/use-user-settings";
import { courseSlotsForDate } from "@/lib/courses";
import { todayKey } from "@/lib/dates";
import { isBreakMode } from "@/lib/terms";
import { weeklyPlanningSlotForDate } from "@/lib/weekplan";
import type { Course, DailySchedule, Task, Term } from "@/types";

export default function CalendarPage() {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { allCheckpoints } = useCourseCheckpoints(courses);
  const { items: schedules } = useUserCollection<DailySchedule>("dailySchedules", useMemo(() => [orderBy("updatedAt", "desc")], []));
  const { settings } = useUserSettings();

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 })
  });

  const today = todayKey();
  const needsTerm = courses.length > 0 && isBreakMode(terms, today);

  return (
    <>
      <SectionHeader title="Calendar" eyebrow="Classes, assessments, and schedule status">
        <div className="flex items-center gap-2">
          <button className="btn-secondary px-2" onClick={() => setMonth((current) => subMonths(current, 1))} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-medium">{format(month, "MMMM yyyy")}</span>
          <button className="btn-secondary px-2" onClick={() => setMonth((current) => addMonths(current, 1))} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </SectionHeader>
      {needsTerm ? (
        <div className="card mb-4 flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
          <span>
            You have courses, but no active term — class blocks won&apos;t show on Calendar or Plan/Day until one covers today.
          </span>
          <Link href="/settings#term-add" className="btn-secondary py-1 text-xs">
            Set up a term
          </Link>
        </div>
      ) : null}
      <div className="mb-2 flex flex-wrap gap-3 text-xs text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-fuchsia-500/60" />
          Class
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-sky-500/60" />
          Assessment due
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-amberline/60" />
          Task due
        </span>
      </div>
      <div className="card overflow-hidden p-0">
        <div className="grid grid-cols-7 border-b border-ink-200 text-xs font-semibold uppercase text-ink-500 dark:border-ink-800">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
            <div key={label} className="px-2 py-2 text-center">
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const dateKey = format(day, "yyyy-MM-dd");
            const classes = isBreakMode(terms, dateKey) ? [] : courseSlotsForDate(courses, dateKey);
            const dueTasks = tasks.filter((task) => task.dueDate === dateKey);
            const dueCheckpoints = allCheckpoints.filter((checkpoint) => checkpoint.dueAt === dateKey);
            const hasSchedule = schedules.some((schedule) => schedule.dateKey === dateKey && schedule.slots.length > 0);
            const weeklyPlanningSlot = weeklyPlanningSlotForDate(settings.weeklyPlanning, dateKey);
            return (
              <Link
                key={dateKey}
                href={`/plan/day?date=${dateKey}`}
                className={`min-h-28 border-b border-r border-ink-200 p-2 text-left text-xs transition hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800 ${
                  isSameMonth(day, month) ? "" : "opacity-40"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`font-medium ${isToday(day) || dateKey === today ? "rounded-full bg-moss-600 px-1.5 py-0.5 text-white" : ""}`}
                  >
                    {format(day, "d")}
                  </span>
                  {hasSchedule ? <span className="h-1.5 w-1.5 rounded-full bg-moss-500" title="Schedule planned" aria-label="Schedule planned" /> : null}
                </div>
                <div className="mt-1 space-y-0.5">
                  {weeklyPlanningSlot ? (
                    <p className="truncate rounded bg-moss-500/10 px-1 py-0.5 text-moss-700 dark:text-moss-300">Weekly planning</p>
                  ) : null}
                  {classes.slice(0, 2).map((slot) => (
                    <p key={slot.id} className="truncate rounded bg-fuchsia-500/10 px-1 py-0.5 text-fuchsia-700 dark:text-fuchsia-300">
                      {slot.title}
                    </p>
                  ))}
                  {dueCheckpoints.map((checkpoint) => (
                    <p key={checkpoint.id} className="truncate rounded bg-sky-500/10 px-1 py-0.5 text-sky-700 dark:text-sky-300">
                      Due: {checkpoint.title}
                    </p>
                  ))}
                  {dueTasks.slice(0, 2).map((task) => (
                    <p key={task.id} className={`truncate rounded bg-amberline/10 px-1 py-0.5 text-amber-700 dark:text-amber-300 ${task.status === "done" ? "line-through opacity-60" : ""}`}>
                      {task.title}
                    </p>
                  ))}
                  {classes.length > 2 || dueTasks.length > 2 ? (
                    <p className="truncate px-1 text-ink-500">
                      +{Math.max(0, classes.length - 2) + Math.max(0, dueTasks.length - 2)} more
                    </p>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </>
  );
}
