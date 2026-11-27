/**
 * plan/19 §3 — what Claude sees of each record: the stored fields that mean something to a person,
 * plus the derived values computed the way the app computes them (never a second stored copy).
 */
import { effectiveCourseStatus } from "@/lib/courses";
import { derivePaperStatus, isBackFromShelf, nextReadingPass, PASS_LABELS } from "@/lib/papers";
import { computeSlotStatus, isFixedSlot, isLockedSlot, slotDuration, sortedSlots } from "@/lib/schedule";
import { slotAutoStatus, slotCoverageMinutes } from "@/lib/tracking";
import { compact } from "@/lib/mcp/context";
import type { Course, Paper, PomodoroSession, ScheduleSlot, Task } from "@/types";

export type Timing = "past" | "now" | "upcoming";

/**
 * A block as the app shows it at this moment. `timing` is the clock's view (a past date is all past, a
 * future one all upcoming, today is read against the person's own wall-clock minute). `closed` is
 * `slotAutoStatus`'s 60% rule, the one definition of a finished sitting. `editable` is false for the
 * locked layer and for anything that has started.
 */
export function blockView(slot: ScheduleSlot, ctx: { dateKey: string; scheduleDay: string; minute: number; sessionsOnDate: PomodoroSession[] }) {
  const timing: Timing =
    ctx.dateKey < ctx.scheduleDay ? "past" : ctx.dateKey > ctx.scheduleDay ? "upcoming" : (({ active: "now", completed: "past", upcoming: "upcoming", skipped: "past" }) as const)[computeSlotStatus({ ...slot, status: "upcoming" }, ctx.minute)];
  const covered = slotCoverageMinutes(slot, ctx.sessionsOnDate);
  const locked = isLockedSlot(slot);
  const fixed = isFixedSlot(slot);
  return compact({
    slotId: slot.id,
    title: slot.title,
    type: slot.type,
    startTime: slot.startTime,
    endTime: slot.endTime,
    minutes: slotDuration(slot),
    status: slot.status,
    timing,
    coveredMinutes: covered || undefined,
    closed: slot.type !== "class" && slotAutoStatus(slot, ctx.sessionsOnDate) === "completed" ? true : undefined,
    layer: locked ? "locked" : fixed ? "fixed" : undefined,
    editable: !locked && !fixed && timing === "upcoming" && covered === 0 && slot.status === "upcoming",
    taskIds: slot.assignedTaskIds,
    courseId: slot.courseId,
    bucket: slot.bucket,
    objective: slot.objectiveRef,
    sitting: slot.chunk ? `${slot.chunk.index} of ${slot.chunk.total}` : undefined,
    plannedMinutes: slot.plannedMinutes,
    note: slot.note || undefined
  });
}

export function blocksView(slots: ScheduleSlot[], ctx: Parameters<typeof blockView>[1]) {
  return sortedSlots(slots).map((slot) => blockView(slot, ctx));
}

export function taskView(task: Task, opts: { full?: boolean } = {}) {
  const left = task.estimatedPomodoros !== undefined ? Math.max(0, task.estimatedPomodoros - (task.completedPomodoros ?? 0)) : undefined;
  return compact({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    category: task.category,
    dueDate: task.dueDate,
    courseId: task.courseId,
    bucket: task.bucket,
    kind: task.kind === "external" ? "external (hard deadline, outside Workload)" : undefined,
    estimatedSessions: task.estimatedPomodoros,
    sessionsDone: task.completedPomodoros,
    sessionsLeft: left,
    weeklyTargetDay: task.weeklyTargetDay,
    maxChunkMinutes: task.maxChunkMinutes,
    splittable: task.splittable,
    fixedTime: task.fixedTime,
    recurring: task.seriesId ? true : undefined,
    completedAt: task.completedAt,
    description: opts.full ? task.description : task.description?.slice(0, 200),
    ...(opts.full ? { reminderLeadDays: task.reminderLeadDays, seriesId: task.seriesId, createdAt: task.createdAt, updatedAt: task.updatedAt } : {})
  });
}

const PRIORITY_RANK: Record<Task["priority"], number> = { high: 0, medium: 1, low: 2 };

/** Due date first (undated last), then priority — the order "what's open" is listed in. */
export function taskOrder(a: Task, b: Task): number {
  const due = (a.dueDate ?? "9999") .localeCompare(b.dueDate ?? "9999");
  return due !== 0 ? due : PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
}

export function paperView(paper: Paper, todayKey: string) {
  const status = derivePaperStatus(paper);
  const pass = (n: 1 | 2 | 3) => paper[`pass${n}` as const]?.status;
  const next = nextReadingPass(paper);
  return compact({
    id: paper.id,
    title: paper.title,
    authors: paper.authors?.slice(0, 4),
    year: paper.year,
    venue: paper.venue,
    status,
    backFromShelf: status === "shelved" && isBackFromShelf(paper, todayKey) ? true : undefined,
    shelvedUntil: typeof paper.shelvedUntil === "string" ? paper.shelvedUntil : undefined,
    progress: paper.progress,
    priority: paper.priority,
    tags: paper.tags,
    queued: paper.queuedAt ? true : undefined,
    inbox: paper.inbox,
    nextPass: next ? `${next} (${PASS_LABELS[next]})` : undefined,
    passes: compact({ skim: pass(1), read: pass(2), deepDive: pass(3) }),
    goal: paper.goal,
    relatedCourseId: paper.relatedCourseId,
    groupIds: paper.groupIds,
    hasPdf: paper.fileId ? true : undefined,
    hasLayeredSummary: paper.layeredNotes ? true : undefined
  });
}

export function courseView(course: Course, todayKey: string) {
  return compact({
    id: course.id,
    name: course.name,
    code: course.code,
    status: effectiveCourseStatus(course, todayKey),
    termId: course.termId,
    instructor: course.instructor,
    startDate: course.startDate,
    endDate: course.endDate,
    weeklyTargets: compact({
      revisionMinutes: course.targetMinutesPerWeek,
      assignmentMinutes: course.weeklyTargets?.assignment,
      backlogMinutes: course.weeklyTargets?.backlog
    }),
    autoRevisionTasks: course.autoRevisionTasks,
    sessions: course.sessions?.map((session) => compact({ dayOfWeek: session.dayOfWeek, startTime: session.startTime, endTime: session.endTime, location: session.location }))
  });
}
