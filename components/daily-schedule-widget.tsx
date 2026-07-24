"use client";

import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  computeSlotStatus,
  dayProgressPercent,
  formatMinutes,
  getActiveSlot,
  getNextSlot,
  minutesFromTime,
  scheduleSummary,
  slotProgressPercent,
  slotTypeLabels,
  slotTypeStyles,
  sortedSlots,
  taskNamesForSlot
} from "@/lib/schedule";
import type { DailySchedule, Task } from "@/types";
import { clsx } from "clsx";

export function DailyScheduleWidget({ schedule, tasks, compact = false }: { schedule?: DailySchedule; tasks: Task[]; compact?: boolean }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const minute = now.getHours() * 60 + now.getMinutes();
  const slots = useMemo(() => sortedSlots(schedule?.slots ?? []), [schedule]);
  const active = getActiveSlot(slots, minute);
  const next = getNextSlot(slots, minute);
  const summary = scheduleSummary(slots, minute);
  const dayProgress = dayProgressPercent(minute);
  const currentProgress = slotProgressPercent(active, minute);

  if (!schedule || slots.length === 0) {
    return (
      <section className={`card ${compact ? "p-4" : "p-5"}`}>
        <div className="flex items-start gap-3">
          <CalendarClock className="mt-1 h-5 w-5 text-moss-600" />
          <div>
            <h2 className="text-lg font-semibold">Daily schedule</h2>
            <p className="mt-2 text-sm leading-6 text-ink-600 dark:text-ink-300">
              No full-day schedule exists for today. Apply a template or create a plan to turn the dashboard into a live operating view.
            </p>
            <Link href="/planner/day" className="btn-primary mt-4">
              Plan today
            </Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`card ${compact ? "p-4" : "p-5"}`}>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="label">Full-day schedule</p>
          <h2 className="mt-1 text-lg font-semibold">Today in progress</h2>
        </div>
        <Link href={`/planner/day?date=${schedule.dateKey}`} className="btn-secondary py-1.5">
          Edit day
        </Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Metric label="Day complete" value={`${dayProgress}%`} />
        <Metric label="Deep work planned" value={formatMinutes(summary.plannedDeepWork)} />
        <Metric label="Deep work done" value={formatMinutes(summary.completedDeepWork)} />
      </div>
      <div className="mt-4">
        <div className="mb-2 flex justify-between text-xs text-ink-500">
          <span>00:00</span>
          <span>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span>23:59</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
          <div className="h-full bg-moss-600" style={{ width: `${dayProgress}%` }} />
        </div>
      </div>
      <div className="mt-3 flex h-4 overflow-hidden rounded-md border border-ink-200 bg-ink-100 dark:border-ink-800 dark:bg-ink-800" aria-label="Full day slot timeline">
        {slots.map((slot) => (
          <div
            key={slot.id}
            className={clsx("min-w-1 border-r border-white/70 dark:border-ink-950", computeSlotStatus(slot, minute) === "active" ? "bg-moss-600" : "bg-ink-300 dark:bg-ink-700")}
            style={{ flexGrow: Math.max(1, minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime)) }}
            title={`${slot.startTime}-${slot.endTime} ${slot.title}`}
          />
        ))}
      </div>
      <div className={`${compact ? "mt-4 grid gap-3" : "mt-5 grid gap-4 lg:grid-cols-[1fr_0.8fr]"}`}>
        <div className="rounded-md border border-ink-200 p-3 dark:border-ink-800">
          <p className="label mb-2">Current slot</p>
          {active ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className={clsx("rounded border px-2 py-1 text-xs font-medium", slotTypeStyles[active.type])}>
                  {slotTypeLabels[active.type]}
                </span>
                <span className="text-sm text-ink-500">
                  {active.startTime} - {active.endTime}
                </span>
              </div>
              <h3 className={`${compact ? "mt-2 text-lg" : "mt-3 text-xl"} font-semibold`}>{active.title}</h3>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
                <div className="h-full bg-amberline" style={{ width: `${currentProgress}%` }} />
              </div>
              <p className="mt-2 text-sm text-ink-500">
                {formatMinutes(Math.max(0, minute - minutesFromTime(active.startTime)))} elapsed ·{" "}
                {formatMinutes(Math.max(0, minutesFromTime(active.endTime) - minute))} remaining
              </p>
              <TaskNames names={taskNamesForSlot(active, tasks)} />
            </>
          ) : (
            <p className="text-sm text-ink-500">No slot is active right now.</p>
          )}
        </div>
        <div className="rounded-md border border-ink-200 p-3 dark:border-ink-800">
          <p className="label mb-2">Next</p>
          {next ? (
            <>
              <h3 className="font-semibold">{next.title}</h3>
              <p className="mt-1 text-sm text-ink-500">
                {next.startTime} - {next.endTime} · {slotTypeLabels[next.type]}
              </p>
              <TaskNames names={taskNamesForSlot(next, tasks)} />
            </>
          ) : (
            <p className="text-sm text-ink-500">No upcoming slots left today.</p>
          )}
          <div className="mt-4 rounded-md bg-ink-50 p-3 text-sm dark:bg-ink-800">
            {summary.completedSlots} of {summary.totalSlots} planned slots completed
          </div>
        </div>
      </div>
      <div className={`${compact ? "mt-4 grid gap-2 md:grid-cols-2" : "mt-5 space-y-2"}`}>
        {(compact ? slots.filter((slot) => computeSlotStatus(slot, minute) !== "completed").slice(0, 4) : slots).map((slot) => {
          const status = computeSlotStatus(slot, minute);
          return (
            <div key={slot.id} className={clsx("grid gap-2 rounded-md border p-2 text-xs sm:grid-cols-[88px_1fr_auto]", status === "active" ? "border-moss-600 bg-moss-600/5" : "border-ink-200 dark:border-ink-800")}>
              <span className="font-mono text-xs text-ink-500">{slot.startTime} - {slot.endTime}</span>
              <span className="font-medium">{slot.title}</span>
              <span className="text-xs capitalize text-ink-500">{status}</span>
            </div>
          );
        })}
        {compact && slots.filter((slot) => computeSlotStatus(slot, minute) !== "completed").length > 4 ? (
          <Link href={`/planner/day?date=${schedule.dateKey}`} className="btn-secondary py-2 text-xs">
            View all slots
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-ink-50 p-2.5 dark:bg-ink-800">
      <p className="label">{label}</p>
      <p className="mt-1 text-base font-semibold">{value}</p>
    </div>
  );
}

function TaskNames({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {names.map((name) => (
        <span key={name} className="rounded bg-white px-2 py-1 text-xs text-ink-600 ring-1 ring-ink-200 dark:bg-ink-900 dark:text-ink-300 dark:ring-ink-700">
          {name}
        </span>
      ))}
    </div>
  );
}
