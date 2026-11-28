/**
 * plan/19 §3.2 — the read tools. Every one is `readOnlyHint: true`, so claude.ai can allow them
 * without asking. Every path is built from `ctx.uid`; no tool takes a uid.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { FieldPath } from "firebase-admin/firestore";
import { parseISO } from "date-fns";
import { z } from "zod";
import { loadIndexForDay } from "@/lib/admin-dailyloop";
import { userCol, userRef } from "@/lib/admin-writes";
import { effectiveCourseStatus, isFromDroppedCourse, plannableTasks } from "@/lib/courses";
import { addDaysToKey, weekDates, weekStartKey } from "@/lib/dates";
import { goalWeekPace, overdueMilestones } from "@/lib/goals";
import { computeCourseCoverage, computeDebtHours, computeLoadIndexStreak, loadIndexBand, loadIndexBandLabels } from "@/lib/loadindex";
import { computeDayReadout, formatDayReadout, isScoredSitting } from "@/lib/gamify";
import { compact, fail, isPlainId, ok, paginate, requireModule, type ToolContext } from "@/lib/mcp/context";
import { dayAsOpened } from "@/lib/mcp/day";
import { blocksView, courseView, paperView, taskOrder, taskView } from "@/lib/mcp/views";
import { pickNextAction } from "@/lib/next-action";
import { DEADLINE_ALERT_DAYS, unplannedHardDeadlines } from "@/lib/deadlines";
import { dayShapeWindows, DEFAULT_MAX_SITTINGS_PER_DAY } from "@/lib/weekplan";
import { derivePaperStatus } from "@/lib/papers";
import { buildReviewQueue, DEFAULT_MAX_REVISION_MINUTES_PER_DAY, DEFAULT_MAX_REVISIONS_PER_DAY } from "@/lib/revision";
import { getActiveSlot, getNextSlot, minutesFromTime, slotDuration, sortedSlots } from "@/lib/schedule";
import { pastBlockOutcome, sittingPlannedMinutes, slotCoverageMinutes } from "@/lib/tracking";
import { getActiveTerm } from "@/lib/terms";
import { sittingBounds } from "@/lib/timeline";
import type {
  Annotation,
  Checkpoint,
  ClassLog,
  Course,
  DailySchedule,
  Day,
  Goal,
  Paper,
  PaperGroup,
  PaperNote,
  PomodoroSession,
  RevisionItem,
  Task,
  Term,
  Topic,
  WeeklyReview
} from "@/types";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-MM-dd");

/** The Monday of the week `dateKey` is in, computed from the key itself, never the server's clock. */
export function weekOf(key: string): string {
  return weekStartKey(parseISO(key));
}

function dayView(day: Day | null | undefined) {
  if (!day) return undefined;
  return compact({
    dayOff: day.dayOff,
    session: day.session,
    review: day.review,
    brief: day.brief,
    rollup: day.rollup ? compact({ summary: day.rollup.summary, improvements: day.rollup.improvements, proposedTasks: day.rollup.proposedTasks, proposedSlots: day.rollup.proposedSlots }) : undefined,
    workloadSnapshot: day.loadIndex,
    dayScoreSnapshot: day.game,
    closed: day.closedAt || day.session?.endedAt ? true : undefined,
    scratchpad: day.scratchpad,
    pinnedTaskIds: day.pinnedTaskIds
  });
}

function weekPlanSummary(review: WeeklyReview | null) {
  const plan = review?.plan;
  if (!plan) return { committed: false };
  return compact({
    committed: Boolean(plan.completedAt),
    committedAt: plan.completedAt,
    targets: plan.targets,
    capacity: plan.capacity,
    readingTarget: plan.readingTarget,
    proposedBlocks: plan.proposedBlocks?.length,
    replans: plan.revisions?.length
  });
}

function sessionsOn(sessions: PomodoroSession[], date: string, slotDay: (s: PomodoroSession) => string) {
  return sessions.filter((session) => slotDay(session) === date);
}

/**
 * What catch-up hours are made of. The figure is Workload's shortfall (required − actual minutes) summed
 * over the last 14 day records, not a list of blocks; required minutes are the day's deep_work blocks,
 * revision due, assessment prep and the daily share of course and goal targets. So each short day is listed with its numbers, and
 * beside it the work blocks that day that passed with no focus time (missed) or too little (partial).
 */
async function catchUpBreakdown(ctx: ToolContext, history: { date: string; requiredMinutes: number; actualMinutes: number }[], sessions: PomodoroSession[], slotDay: (s: PomodoroSession) => string, scheduleDay: string, minute: number) {
  const short = history.slice(-14).filter((day) => day.requiredMinutes > day.actualMinutes);
  if (short.length === 0) return [];
  const snap = await userCol(ctx.uid, "dailySchedules").where(FieldPath.documentId(), "in", short.map((day) => day.date)).get();
  ctx.meter.reads += Math.max(1, snap.size);
  const slotsByDate = new Map(snap.docs.map((doc) => [doc.id, (doc.data() as DailySchedule).slots ?? []]));
  return short.map((day) => {
    const daySessions = sessionsOn(sessions, day.date, slotDay);
    const unworked = sortedSlots(slotsByDate.get(day.date) ?? [])
      .filter((slot) => isScoredSitting(slot) && (day.date < scheduleDay || minutesFromTime(slot.endTime) <= minute))
      .map((slot) => ({ slot, outcome: pastBlockOutcome(slot, daySessions) }))
      .filter(({ outcome }) => outcome === "missed" || outcome === "partial")
      .map(({ slot, outcome }) => compact({ title: slot.title, time: `${slot.startTime}–${slot.endTime}`, outcome, plannedMinutes: sittingPlannedMinutes(slot), loggedMinutes: slotCoverageMinutes(slot, daySessions) || undefined }));
    return compact({ date: day.date, requiredMinutes: day.requiredMinutes, actualMinutes: day.actualMinutes, shortfallMinutes: day.requiredMinutes - day.actualMinutes, unworkedBlocks: unworked });
  });
}

export async function buildOverview(ctx: ToolContext, date?: string) {
  const settings = await ctx.settings();
  const frame = await ctx.frame();
  const modules = await ctx.modules();
  const today = date ?? frame.today;
  const scheduleDay = date ?? frame.scheduleDay;
  const minute = frame.minute;

  // Workload is read through the same input assembly the day snapshot is written from (§2.2).
  const workload = await loadIndexForDay(ctx.uid, today, settings);
  const { tasks, sessions, papers, courses, goals, terms, checkpoints } = workload.data;
  ctx.meter.reads += tasks.length + sessions.length + papers.length + courses.length + goals.length + terms.length + checkpoints.length + 3;

  const [clockSchedule, clockDayDoc, weekReview, profile, recentDays] = await Promise.all([
    scheduleDay === today ? Promise.resolve(workload.schedule) : ctx.get<DailySchedule>("dailySchedules", scheduleDay),
    scheduleDay === today ? Promise.resolve(workload.day ? ({ ...workload.day, id: today } as Day) : null) : ctx.get<Day>("days", scheduleDay),
    ctx.get<WeeklyReview>("weeklyReviews", weekOf(today)),
    userRef(ctx.uid).get().then((doc) => doc.data() as { displayName?: string } | undefined),
    // The dashboard's history window: the 30 latest day records (app/(app)/dashboard/page.tsx).
    userCol(ctx.uid, "days").orderBy("date", "desc").limit(30).get().then((snap) => {
      ctx.meter.reads += Math.max(1, snap.size);
      return snap.docs.map((doc) => doc.data() as Day);
    })
  ]);
  const historyDays = recentDays.filter((d) => d.loadIndex && d.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const history = historyDays.map((d) => d.loadIndex!);
  const catchUpDays = modules.has("workload")
    ? await catchUpBreakdown(ctx, historyDays.map((d) => ({ date: d.date, requiredMinutes: d.loadIndex!.requiredMinutes, actualMinutes: d.loadIndex!.actualMinutes })), sessions, frame.slotDay, frame.scheduleDay, minute)
    : [];
  // `useDayReadout`'s inputs: the logical day's own blocks and sessions, paced against the clock only
  // while that day is the date the clock is on.
  const readout = computeDayReadout({
    slots: workload.schedule?.slots ?? [],
    sessions: sessionsOn(sessions, today, frame.slotDay),
    loadIndex: workload.snapshot,
    isDayOff: Boolean(workload.day?.dayOff),
    nowMinute: !date && today === frame.scheduleDay ? minute : undefined,
    snapshot: workload.day?.game
  });
  const slots = sortedSlots(clockSchedule?.slots ?? []);
  const weekStart = weekOf(today);

  const upNext = date
    ? undefined
    : pickNextAction({
        checkpoints,
        dueRevisionCount: workload.dueRevisionCount,
        tasks: plannableTasks(tasks, courses),
        loadIndexValue: workload.snapshot.value,
        todayKey: today,
        weekEndKey: weekDates(weekStart)[6],
        enabledModules: modules,
        activeSlot: getActiveSlot(slots, minute),
        nextSlot: getNextSlot(slots, minute),
        minute,
        isDayOff: Boolean(clockDayDoc?.dayOff),
        workWindows: dayShapeWindows(settings.dayShape) ?? undefined
      });

  const courseName = new Map(courses.map((course) => [course.id, course.name]));
  const horizon = addDaysToKey(today, 14);
  const openTasks = plannableTasks(tasks, courses).filter((task) => task.status !== "done").sort(taskOrder);
  const activeCourses = courses.filter((course) => effectiveCourseStatus(course, today) === "active");
  const term = getActiveTerm(terms, today);

  return compact({
    person: profile?.displayName,
    now: compact({
      todayKey: today,
      scheduleDayKey: scheduleDay,
      time: date ? undefined : `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
      timezone: frame.timeZone,
      dayEndsAt: settings.dayEndsAt ?? "00:00",
      note: today !== scheduleDay ? "It's after midnight but before this person's day ends: Workload and stats are still on todayKey; the blocks below are scheduleDayKey's." : undefined
    }),
    sittingBounds: sittingBounds(settings),
    dayShape: settings.dayShape ? { ...settings.dayShape, note: "Deep work goes only in deep windows; light work (admin, revision) in light windows first; no work outside them." } : undefined,
    enabledModules: [...modules],
    dayOff: clockDayDoc?.dayOff ?? workload.day?.dayOff,
    blocks: slots.length > 0 ? blocksView(slots, { dateKey: scheduleDay, scheduleDay: frame.scheduleDay, minute, sessionsOnDate: sessionsOn(sessions, scheduleDay, frame.slotDay) }) : "No plan saved for this date yet (the app shows only its classes, commitments and routine until something is added).",
    workload: modules.has("workload")
      ? {
          ...workload.snapshot,
          bandLabel: loadIndexBandLabels[loadIndexBand(workload.snapshot.value)],
          onTrackStreakDays: computeLoadIndexStreak(history),
          catchUpHours14Days: computeDebtHours(history),
          catchUpBreakdown: compact({
            how: "Sum of each day's Workload shortfall (required − actual minutes) over the last 14 day records, capped at 40 h. Required = that day's deep_work blocks + 3 min per revision due + assessment prep owed + the daily share of course and goal weekly targets; actual = focus minutes + 3 per revision done. Reading/admin blocks aren't in required, so the work blocks that passed unworked (missed = no focus time, partial = under 60%) are listed per day beside the numbers, not as what the figure is made of.",
            days: catchUpDays
          }),
          note: "Derived live from today's data; never stored until the day closes."
        }
      : undefined,
    dayScore: modules.has("dayScore") ? { ...readout, line: formatDayReadout(readout) } : undefined,
    upNext: upNext ? compact({ kind: upNext.kind, title: upNext.title, why: upNext.why, taskId: upNext.taskId, slotId: upNext.slot?.id, upcoming: upNext.upcoming }) : undefined,
    revisionDue: modules.has("revise") ? workload.dueRevisionCount : undefined,
    assessmentsNext14Days: modules.has("courses")
      ? checkpoints
          .filter((c) => !["done", "missed", "submitted"].includes(c.status) && c.dueAt.slice(0, 10) >= today && c.dueAt.slice(0, 10) <= horizon)
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
          .map((c) => compact({ id: c.id, courseId: c.courseId, course: courseName.get(c.courseId), title: c.title, type: c.type, dueAt: c.dueAt, status: c.status, weightPct: c.weightPct, prepMinutes: c.requiresPrep ? c.prepEstimateMin : undefined }))

      : undefined,
    currentTerm: term ? { id: term.id, name: term.name, kind: term.kind, startDate: term.startDate, endDate: term.endDate } : "No term covers today (break mode for course classes).",
    activeCourses: modules.has("courses") ? activeCourses.map((course) => courseView(course, today)) : undefined,
    papersInFlight: papers
      .map((paper) => paperView(paper, today))
      .filter((paper) => paper.status === "reading" || paper.queued || paper.backFromShelf)
      .slice(0, 20),
    papersInInbox: papers.filter((paper) => derivePaperStatus(paper) === "inbox").length,
    activeGoals: modules.has("goals")
      ? goals
          .filter((goal) => goal.status === "active")
          .map((goal) => compact({ id: goal.id, title: goal.title, horizon: goal.horizon, targetHoursPerWeek: goal.targetHoursPerWeek, definitionOfDone: goal.definitionOfDone, openMilestones: goal.milestones.filter((m) => !m.done).map((m) => compact({ id: m.id, title: m.title, dueAt: m.dueAt })) }))
      : undefined,
    overdueMilestones: modules.has("goals") ? overdueMilestones(goals, today) : undefined,
    goalPaceWarnings: modules.has("goals")
      ? await (async () => {
          const dates = weekDates(weekStart);
          const week = await Promise.all(dates.map(async (d) => ({ dateKey: d, slots: (await ctx.get<DailySchedule>("dailySchedules", d))?.slots ?? [] })));
          const warnings = goalWeekPace({ goals, schedules: week, sessions, weekDateKeys: dates, todayKey: frame.scheduleDay, nowMinutes: minute }).filter((g) => g.warning).map((g) => g.warning!);
          return warnings.length > 0 ? warnings : undefined;
        })()
      : undefined,
    hardDeadlinesUnplanned: await (async () => {
      // External tasks are outside Workload, so nothing else pushes for them: flag one due soon with no time blocked.
      const horizonKeys = Array.from({ length: DEADLINE_ALERT_DAYS + 1 }, (_, i) => addDaysToKey(scheduleDay, i));
      const snap = await userCol(ctx.uid, "dailySchedules").where(FieldPath.documentId(), "in", horizonKeys).get();
      ctx.meter.reads += Math.max(1, snap.size);
      const due = unplannedHardDeadlines({ tasks: plannableTasks(tasks, courses), schedules: snap.docs.map((doc) => doc.data() as DailySchedule), todayKey: scheduleDay });
      return due.length > 0
        ? { note: `Hard deadlines in the next ${DEADLINE_ALERT_DAYS} days with no block assigned. Offer to schedule them (add_block or add_session with taskIds).`, tasks: due.map(({ task, daysLeft }) => compact({ id: task.id, title: task.title, dueDate: task.dueDate, daysLeft, estimatedSessions: task.estimatedPomodoros })) }
        : undefined;
    })(),
    openTasks: {
      count: openTasks.length,
      overdue: openTasks.filter((task) => task.dueDate && task.dueDate < today).length,
      top: openTasks.slice(0, 15).map((task) => taskView(task)),
      ...(openTasks.length > 15 ? { more: `${openTasks.length - 15} more — use list_tasks.` } : {})
    },
    thisWeek: { weekStart, ...weekPlanSummary(weekReview) }
  });
}

const COLLECTIONS = [
  "tasks",
  "pomodoroSessions",
  "days",
  "dailySchedules",
  "dayTemplates",
  "weeklyReviews",
  "terms",
  "courses",
  "topics",
  "revisionItems",
  "papers",
  "paperGroups",
  "files",
  "aiInsights",
  "goals",
  "recurringTaskTemplates",
  "alerts",
  "usage",
  "meta",
  "integrations",
  "googleCalendarLinks",
  "mcpActivity"
] as const;
const SUBCOLLECTIONS = { checkpoints: "courses", classLogs: "courses", notes: "papers", annotations: "papers" } as const;

/** Never handed out, even through the escape hatch: Google's incremental-sync cursors. */
function scrub(name: string, data: Record<string, unknown>) {
  if (name === "integrations") {
    const { syncTokens: _syncTokens, ...rest } = data;
    return rest;
  }
  if (name === "annotations") {
    const { quads: _quads, ...rest } = data;
    return rest;
  }
  return data;
}

export function registerReadTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "get_overview",
    {
      title: "Overview of today",
      description:
        "Start here. One call for today: the day frame (todayKey vs scheduleDayKey, timezone, clock time), sitting bounds, today's blocks with live status, Workload and its band, Up next, revision due, assessments in the next 14 days, the current term and active courses, papers in flight, active goals and overdue milestones, open tasks (count plus the top 15 by due date and priority), this week's plan, and day-off status. Pass `date` to see another day's blocks and Workload (Up next is only for now).",
      inputSchema: z.object({ date: dateKey.optional() }),
      annotations: READ
    },
    async ({ date }) => ok(await buildOverview(ctx, date))
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Tasks, ordered by due date then priority. Defaults to open tasks (todo and in progress). Filters: status (todo | in_progress | done | open | all), courseId, bucket, dueBefore (yyyy-MM-dd, inclusive). Tasks from a dropped course are left out unless includeDroppedCourses is true.",
      inputSchema: z.object({
        status: z.enum(["todo", "in_progress", "done", "open", "all"]).optional(),
        courseId: z.string().optional(),
        bucket: z.enum(["goal", "assignment", "backlog", "revision"]).optional(),
        dueBefore: dateKey.optional(),
        includeDroppedCourses: z.boolean().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional()
      }),
      annotations: READ
    },
    async ({ status = "open", courseId, bucket, dueBefore, includeDroppedCourses, cursor, limit = 50 }) => {
      const [tasks, courses] = await Promise.all([ctx.list<Task>("tasks"), ctx.list<Course>("courses")]);
      const filtered = tasks
        .filter((task) => (status === "all" ? true : status === "open" ? task.status !== "done" : task.status === status))
        .filter((task) => !courseId || task.courseId === courseId)
        .filter((task) => !bucket || task.bucket === bucket)
        .filter((task) => !dueBefore || (task.dueDate !== undefined && task.dueDate <= dueBefore))
        .filter((task) => includeDroppedCourses || !isFromDroppedCourse(task, courses))
        .sort(taskOrder)
        .map((task) => taskView(task));
      return ok(paginate(filtered, cursor, limit));
    }
  );

  server.registerTool(
    "get_task",
    { title: "Get a task", description: "One task in full, with the course it belongs to and the blocks it is assigned to in the next 14 days.", inputSchema: z.object({ id: z.string() }), annotations: READ },
    async ({ id }) => {
      const task = await ctx.get<Task>("tasks", id);
      if (!task) return fail(`No task with id ${id}.`);
      const frame = await ctx.frame();
      const horizon = addDaysToKey(frame.scheduleDay, 14);
      const schedules = (await ctx.list<DailySchedule>("dailySchedules")).filter((s) => s.dateKey >= frame.scheduleDay && s.dateKey <= horizon);
      const blocks = schedules.flatMap((s) => s.slots.filter((slot) => slot.assignedTaskIds?.includes(id)).map((slot) => ({ date: s.dateKey, slotId: slot.id, title: slot.title, startTime: slot.startTime, endTime: slot.endTime })));
      const course = task.courseId ? await ctx.get<Course>("courses", task.courseId) : null;
      return ok(compact({ ...taskView(task, { full: true }), course: course ? { id: course.id, name: course.name, status: effectiveCourseStatus(course, frame.today) } : undefined, plannedBlocks: blocks }));
    }
  );

  server.registerTool(
    "get_day",
    {
      title: "Get a day",
      description:
        "One date: its blocks with live status and coverage, the day record (day off, session, review, brief, wrap-up, stored Workload and day-score snapshots, whether it's closed), and that day's focus sessions. Defaults to scheduleDayKey.",
      inputSchema: z.object({ date: dateKey.optional() }),
      annotations: READ
    },
    async ({ date }) => {
      const frame = await ctx.frame();
      const key = date ?? frame.scheduleDay;
      const [schedule, day, sessions] = await Promise.all([ctx.get<DailySchedule>("dailySchedules", key), ctx.get<Day>("days", key), ctx.list<PomodoroSession>("pomodoroSessions")]);
      const onDate = sessionsOn(sessions, key, frame.slotDay);
      const opened = await dayAsOpened(ctx, key, schedule?.slots ?? []);
      const saved = new Set((schedule?.slots ?? []).map((slot) => slot.id));
      const countedForDay = sessions.filter((session) => frame.sessionDay(session) === key && session.mode === "work");
      return ok(
        compact({
          date: key,
          readOnly: key < frame.today || Boolean(day?.closedAt || day?.session?.endedAt) ? "Past or closed day: read-only through this connection." : undefined,
          savedSchedule: schedule ? undefined : "Nothing saved for this date yet; the blocks below are its classes, commitments and routine, as the app shows them.",
          blocks: blocksView(opened, { dateKey: key, scheduleDay: frame.scheduleDay, minute: frame.minute, sessionsOnDate: onDate }).map((block) => (saved.has(block.slotId as string) || !schedule ? block : { ...block, notYetSaved: true })),
          day: dayView(day),
          focus: {
            sessions: countedForDay.map((s) => compact({ label: s.label, minutes: s.minutes, completedAt: s.completedAt, category: s.category, taskId: s.taskId, slotId: s.slotId, paperId: s.paperId, passNo: s.passNo, courseId: s.courseId, rating: s.productivityRating, comment: s.comment })),
            totalMinutes: countedForDay.reduce((sum, s) => sum + s.minutes, 0)
          }
        })
      );
    }
  );

  server.registerTool(
    "get_week",
    {
      title: "Get a week",
      description:
        "Seven days (Monday to Sunday) of blocks, days off, the week's plan from /plan/week, and its weekly review. weekStart is that week's Monday; defaults to this week. compact: true lists the routine blocks (Sleep, meals, Gym…) once and then only each day's other blocks. Also: sittings per day against the sustainable cap, and each goal's weekly hours (planned and logged) against its target, with a pace warning.",
      inputSchema: z.object({ weekStart: dateKey.optional(), compact: z.boolean().optional() }),
      annotations: READ
    },
    async ({ weekStart, compact: compactView }) => {
      const frame = await ctx.frame();
      const settings = await ctx.settings();
      const start = weekOf(weekStart ?? frame.today);
      const dates = weekDates(start);
      const [schedules, days, review, sessions, goals] = await Promise.all([
        Promise.all(dates.map(async (d) => dayAsOpened(ctx, d, (await ctx.get<DailySchedule>("dailySchedules", d))?.slots ?? []))),
        Promise.all(dates.map((d) => ctx.get<Day>("days", d))),
        ctx.get<WeeklyReview>("weeklyReviews", start),
        ctx.list<PomodoroSession>("pomodoroSessions"),
        ctx.list<Goal>("goals")
      ]);
      const cap = settings.maxSittingsPerDay ?? DEFAULT_MAX_SITTINGS_PER_DAY;
      const views = dates.map((d, i) => blocksView(schedules[i], { dateKey: d, scheduleDay: frame.scheduleDay, minute: frame.minute, sessionsOnDate: sessionsOn(sessions, d, frame.slotDay) }).map((b) => compact({ ...b, note: undefined })));
      // The routine repeats every day; in compact mode it is listed once, with the days it's on.
      const routineKey = (b: { slotId: string; startTime: string; endTime: string }) => `${b.slotId}|${b.startTime}|${b.endTime}`;
      const routine = new Map<string, { title?: string; time: string; days: string[] }>();
      if (compactView) {
        views.forEach((blocks, i) => {
          for (const b of blocks) {
            if (!b.slotId?.startsWith("routine-") && b.slotId !== "weekly-planning") continue;
            const key = routineKey(b as { slotId: string; startTime: string; endTime: string });
            const entry = routine.get(key) ?? { title: b.title, time: `${b.startTime}–${b.endTime}`, days: [] };
            entry.days.push(dates[i]);
            routine.set(key, entry);
          }
        });
      }
      const sittingCounts = schedules.map((slots) => slots.filter(isScoredSitting).length);
      const pace = goalWeekPace({ goals, schedules: dates.map((d, i) => ({ dateKey: d, slots: schedules[i] })), sessions, weekDateKeys: dates, todayKey: frame.scheduleDay, nowMinutes: frame.minute });
      return ok(
        compact({
          weekStart: start,
          routine: compactView ? [...routine.values()].map((r) => ({ title: r.title, time: r.time, days: r.days.length === 7 ? "every day" : r.days })) : undefined,
          days: dates.map((d, i) =>
            compact({
              date: d,
              dayOff: days[i]?.dayOff,
              sittings: sittingCounts[i] || undefined,
              overSittingCap: sittingCounts[i] > cap ? `${sittingCounts[i]} sittings is over the sustainable ${cap} a day.` : undefined,
              blocks: compactView ? views[i].filter((b) => !b.slotId?.startsWith("routine-") && b.slotId !== "weekly-planning") : views[i]
            })
          ),
          load: compact({
            sittingCapPerDay: cap,
            plannedWorkHours: Math.round((schedules.flatMap((slots) => slots.filter(isScoredSitting)).reduce((sum, slot) => sum + slotDuration(slot), 0) / 60) * 10) / 10,
            goals: pace.length > 0 ? pace.map((g) => compact({ ...g, targetHours: g.targetMinutes / 60, plannedHours: Math.round((g.plannedMinutes / 60) * 10) / 10, loggedHours: Math.round((g.loggedMinutes / 60) * 10) / 10, targetMinutes: undefined, plannedMinutes: undefined, loggedMinutes: undefined })) : undefined
          }),
          plan: review?.plan ? { ...weekPlanSummary(review), proposedBlocks: review.plan.proposedBlocks, dismissedMinutes: review.plan.dismissedMinutes } : { committed: false },
          review: review ? compact({ wins: review.wins, missedGoals: review.missedGoals, blockers: review.blockers, nextWeekPriorities: review.nextWeekPriorities, averageFocusRating: review.averageFocusRating }) : undefined
        })
      );
    }
  );

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description: "Courses with their effective status (a course past its end date reads as completed), term, weekly targets and class sessions. Defaults to active courses; status: active | completed | dropped | all.",
      inputSchema: z.object({ status: z.enum(["active", "completed", "dropped", "all"]).optional(), termId: z.string().optional() }),
      annotations: READ
    },
    async ({ status = "active", termId }) => {
      const blocked = await requireModule(ctx, "courses", "Courses");
      if (blocked) return blocked;
      const frame = await ctx.frame();
      const courses = await ctx.list<Course>("courses");
      return ok(courses.map((course) => courseView(course, frame.today)).filter((c) => (status === "all" || c.status === status) && (!termId || c.termId === termId)));
    }
  );

  server.registerTool(
    "get_course",
    {
      title: "Get a course",
      description: "One course with its assessments, class logs (latest 30), topics, topics revised (derived), linked goals, and open tasks.",
      inputSchema: z.object({ id: z.string() }),
      annotations: READ
    },
    async ({ id }) => {
      const blocked = await requireModule(ctx, "courses", "Courses");
      if (blocked) return blocked;
      const course = await ctx.get<Course>("courses", id);
      if (!course) return fail(`No course with id ${id}.`);
      const frame = await ctx.frame();
      const [checkpoints, classLogs, topics, revisionItems, goals, tasks] = await Promise.all([
        ctx.sub<Checkpoint>("courses", id, "checkpoints"),
        ctx.sub<ClassLog>("courses", id, "classLogs"),
        ctx.list<Topic>("topics"),
        ctx.list<RevisionItem>("revisionItems"),
        ctx.list<Goal>("goals"),
        ctx.list<Task>("tasks")
      ]);
      const courseTopics = topics.filter((t) => t.courseId === id);
      return ok(
        compact({
          ...courseView(course, frame.today),
          topicsRevised: computeCourseCoverage(topics, revisionItems, id),
          assessments: checkpoints.sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map((c) => compact({ ...c, courseId: undefined, createdAt: undefined, updatedAt: undefined })),
          classLogs: classLogs.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map((log) => compact({ ...log, courseId: undefined, updatedAt: undefined })),
          topics: courseTopics.map((t) => compact({ id: t.id, title: t.title, confidence: t.confidence, status: t.status, firstSeenDate: t.firstSeenDate })),
          linkedGoals: goals.filter((g) => g.linked?.courseIds?.includes(id)).map((g) => ({ id: g.id, title: g.title, status: g.status })),
          openTasks: tasks.filter((t) => t.courseId === id && t.status !== "done").sort(taskOrder).map((t) => taskView(t))
        })
      );
    }
  );

  server.registerTool(
    "list_papers",
    {
      title: "List papers",
      description: "Papers with their derived status (inbox, to_read, reading, read, shelved, dropped), next pass, and queue/shelf state. Filter by status or by a paper set (groupId). Ordered by most recently updated.",
      inputSchema: z.object({
        status: z.enum(["inbox", "to_read", "reading", "read", "shelved", "dropped", "archived", "queued"]).optional(),
        groupId: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional()
      }),
      annotations: READ
    },
    async ({ status, groupId, cursor, limit = 50 }) => {
      const frame = await ctx.frame();
      const papers = await ctx.list<Paper>("papers");
      const views = papers
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .filter((paper) => !groupId || paper.groupIds?.includes(groupId))
        .map((paper) => paperView(paper, frame.today))
        .filter((paper) => !status || (status === "queued" ? paper.queued : paper.status === status));
      return ok(paginate(views, cursor, limit));
    }
  );

  server.registerTool(
    "get_paper",
    {
      title: "Get a paper",
      description: "One paper in full: metadata, reading goal, each pass's state and output, the layered summary, your notes, and your highlights (quote and note; no PDF coordinates). Not the PDF itself.",
      inputSchema: z.object({ id: z.string() }),
      annotations: READ
    },
    async ({ id }) => {
      const paper = await ctx.get<Paper>("papers", id);
      if (!paper) return fail(`No paper with id ${id}.`);
      const frame = await ctx.frame();
      const [notes, annotations] = await Promise.all([ctx.sub<PaperNote>("papers", id, "notes"), ctx.sub<Annotation>("papers", id, "annotations")]);
      const { anthropicFileId: _cached, fileId, ...rest } = paper;
      return ok(
        compact({
          ...rest,
          ...paperView(paper, frame.today),
          hasPdf: fileId ? true : undefined,
          notes: notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((n) => compact({ id: n.id, kind: n.kind, body: n.body, passNo: n.passNo, page: n.anchorPage, quote: n.anchorQuote, createdAt: n.createdAt })),
          highlights: annotations.map((a) => compact({ quote: a.quote, category: a.category, note: a.note, page: a.page, layer: a.layer, source: a.source }))
        })
      );
    }
  );

  server.registerTool(
    "list_goals",
    { title: "List goals", description: "Goals with milestones, horizon, weekly hours target, and linked courses. Defaults to active; status: active | paused | achieved | dropped | all.", inputSchema: z.object({ status: z.enum(["active", "paused", "achieved", "dropped", "all"]).optional() }), annotations: READ },
    async ({ status = "active" }) => {
      const blocked = await requireModule(ctx, "goals", "Goals");
      if (blocked) return blocked;
      const goals = await ctx.list<Goal>("goals");
      return ok(goals.filter((g) => status === "all" || g.status === status).map((g) => compact({ id: g.id, title: g.title, status: g.status, horizon: g.horizon, termId: g.termId, why: g.why, definitionOfDone: g.definitionOfDone, targetHoursPerWeek: g.targetHoursPerWeek, milestones: g.milestones, linkedCourseIds: g.linked?.courseIds, reviewCadence: g.reviewCadence, lastReviewedAt: g.lastReviewedAt })));
    }
  );

  server.registerTool(
    "list_terms",
    { title: "List terms", description: "Semesters and breaks, newest first, marking the one that covers today.", inputSchema: z.object({}), annotations: READ },
    async () => {
      const frame = await ctx.frame();
      const terms = await ctx.list<Term>("terms");
      const current = getActiveTerm(terms, frame.today);
      return ok(terms.sort((a, b) => b.startDate.localeCompare(a.startDate)).map((t) => compact({ id: t.id, name: t.name, kind: t.kind, startDate: t.startDate, endDate: t.endDate, current: t.id === current?.id ? true : undefined })));
    }
  );

  server.registerTool(
    "list_paper_groups",
    { title: "List paper sets", description: "Paper sets and literature surveys, with their paper ids and latest synthesis.", inputSchema: z.object({}), annotations: READ },
    async () => {
      const groups = await ctx.list<PaperGroup>("paperGroups");
      return ok(groups.map((g) => compact({ id: g.id, name: g.name, kind: g.kind, purpose: g.purpose, paperIds: g.paperIds, survey: g.survey, lastSynthesis: g.lastSynthesis })));
    }
  );

  server.registerTool(
    "get_revision_queue",
    {
      title: "Revision queue",
      description: "Revision cards due on a date (defaults to todayKey), and the queue the Revise page would serve after the person's daily card and minute caps and assessment pull-forward.",
      inputSchema: z.object({ date: dateKey.optional() }),
      annotations: READ
    },
    async ({ date }) => {
      const blocked = await requireModule(ctx, "revise", "Revise");
      if (blocked) return blocked;
      const [settings, frame] = await Promise.all([ctx.settings(), ctx.frame()]);
      const key = date ?? frame.today;
      const due = await userCol(ctx.uid, "revisionItems").where("suspended", "==", false).where("dueDate", "<=", key).get();
      ctx.meter.reads += Math.max(1, due.size);
      const items = due.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as RevisionItem);
      const courses = await ctx.list<Course>("courses");
      const checkpoints = (await Promise.all(courses.map((course) => ctx.sub<Checkpoint>("courses", course.id, "checkpoints")))).flat();
      const limits = { maxItems: settings.maxRevisionsPerDay ?? DEFAULT_MAX_REVISIONS_PER_DAY, maxMinutes: settings.maxRevisionMinutesPerDay ?? DEFAULT_MAX_REVISION_MINUTES_PER_DAY };
      const queue = buildReviewQueue(items, checkpoints, key, limits);
      return ok({
        date: key,
        dueCount: items.length,
        limits,
        queue: queue.map((item) => compact({ id: item.id, title: item.title, kind: item.kind, courseId: item.courseId, dueDate: item.dueDate, reps: item.reps, lapses: item.lapses, resurfaced: item.retiredAt ? true : undefined }))
      });
    }
  );

  server.registerTool(
    "get_focus_history",
    {
      title: "Focus history",
      description: "Focus sessions between two dates (inclusive, at most 92 days), each counted on the day it was logged for, with per-day totals in minutes.",
      inputSchema: z.object({ from: dateKey, to: dateKey }),
      annotations: READ
    },
    async ({ from, to }) => {
      if (to < from) return fail("`to` must not be before `from`.");
      if (addDaysToKey(from, 92) < to) return fail("Ask for at most 92 days at a time.");
      const frame = await ctx.frame();
      const sessions = (await ctx.list<PomodoroSession>("pomodoroSessions")).filter((s) => s.mode === "work");
      const inRange = sessions.filter((s) => {
        const day = frame.sessionDay(s);
        return day >= from && day <= to;
      });
      const perDay: Record<string, { minutes: number; sessions: number }> = {};
      for (const s of inRange) {
        const day = frame.sessionDay(s);
        perDay[day] = { minutes: (perDay[day]?.minutes ?? 0) + s.minutes, sessions: (perDay[day]?.sessions ?? 0) + 1 };
      }
      const list = inRange
        .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
        .map((s) => compact({ day: frame.sessionDay(s), label: s.label, minutes: s.minutes, category: s.category, completedAt: s.completedAt, taskId: s.taskId, paperId: s.paperId, courseId: s.courseId, rating: s.productivityRating }));
      const page = paginate(list, undefined, 2000, 100_000);
      return ok({ from, to, totalMinutes: inRange.reduce((sum, s) => sum + s.minutes, 0), perDay, sessions: page.items, ...(page.nextCursor ? { trimmed: `${page.total - page.items.length} sessions left out to fit; ask for a shorter range.` } : {}) });
    }
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description: "Find tasks, papers, courses, goals, topics and assessments whose title or text contains the query (case-insensitive). kinds narrows it; paper notes are searched only when kinds includes \"notes\" (it reads every paper's notes).",
      inputSchema: z.object({ query: z.string().min(2), kinds: z.array(z.enum(["tasks", "papers", "notes", "courses", "goals", "topics", "assessments"])).optional() }),
      annotations: READ
    },
    async ({ query, kinds }) => {
      const want = new Set(kinds ?? ["tasks", "papers", "courses", "goals", "topics", "assessments"]);
      const q = query.toLowerCase();
      const hit = (...texts: (string | undefined)[]) => texts.some((text) => text?.toLowerCase().includes(q));
      const frame = await ctx.frame();
      const results: Record<string, unknown[]> = {};
      const courses = want.has("courses") || want.has("assessments") ? await ctx.list<Course>("courses") : [];
      if (want.has("tasks")) results.tasks = (await ctx.list<Task>("tasks")).filter((t) => hit(t.title, t.description)).sort(taskOrder).slice(0, 50).map((t) => taskView(t));
      const papers = want.has("papers") || want.has("notes") ? await ctx.list<Paper>("papers") : [];
      if (want.has("papers")) results.papers = papers.filter((p) => hit(p.title, p.venue, p.goal, ...(p.authors ?? []), ...(p.tags ?? []))).slice(0, 50).map((p) => paperView(p, frame.today));
      if (want.has("notes")) {
        const notes = (await Promise.all(papers.map(async (p) => (await ctx.sub<PaperNote>("papers", p.id, "notes")).map((n) => ({ ...n, paperTitle: p.title }))))).flat();
        results.notes = notes.filter((n) => hit(n.body, n.anchorQuote)).slice(0, 50).map((n) => compact({ paperId: n.paperId, paperTitle: n.paperTitle, kind: n.kind, body: n.body, createdAt: n.createdAt }));
      }
      if (want.has("courses")) results.courses = courses.filter((c) => hit(c.name, c.code, c.instructor)).map((c) => courseView(c, frame.today));
      if (want.has("goals")) results.goals = (await ctx.list<Goal>("goals")).filter((g) => hit(g.title, g.why, g.definitionOfDone, ...g.milestones.map((m) => m.title))).map((g) => ({ id: g.id, title: g.title, status: g.status }));
      if (want.has("topics")) results.topics = (await ctx.list<Topic>("topics")).filter((t) => hit(t.title)).slice(0, 50).map((t) => ({ id: t.id, title: t.title, courseId: t.courseId, confidence: t.confidence }));
      if (want.has("assessments")) {
        const checkpoints = (await Promise.all(courses.map((c) => ctx.sub<Checkpoint>("courses", c.id, "checkpoints")))).flat();
        results.assessments = checkpoints.filter((c) => hit(c.title)).map((c) => ({ id: c.id, courseId: c.courseId, title: c.title, type: c.type, dueAt: c.dueAt, status: c.status }));
      }
      return ok(results);
    }
  );

  server.registerTool(
    "read_collection",
    {
      title: "Read raw documents",
      description: `The escape hatch: raw documents from one of the person's collections, paginated by document id. Use the other tools first; this has no derived values. Collections: ${COLLECTIONS.join(", ")}. Subcollections (need parentId): checkpoints and classLogs (a course id), notes and annotations (a paper id).`,
      inputSchema: z.object({
        name: z.enum([...COLLECTIONS, ...(Object.keys(SUBCOLLECTIONS) as (keyof typeof SUBCOLLECTIONS)[])]),
        parentId: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional()
      }),
      annotations: READ
    },
    async ({ name, parentId, cursor, limit = 50 }) => {
      const parent = (SUBCOLLECTIONS as Record<string, string>)[name];
      if (parent && !parentId) return fail(`${name} lives under ${parent}/{id}: pass parentId.`);
      if (parentId && !isPlainId(parentId)) return fail("parentId must be a single document id.");
      const col = parent ? userCol(ctx.uid, parent).doc(parentId!).collection(name) : userCol(ctx.uid, name);
      let query = col.orderBy(FieldPath.documentId()).limit(limit);
      if (cursor) query = query.startAfter(Buffer.from(cursor, "base64url").toString("utf-8"));
      const snapshot = await query.get();
      ctx.meter.reads += Math.max(1, snapshot.size);
      const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...scrub(name, doc.data()) }));
      const page = paginate(docs, undefined, limit);
      const lastId = page.items.length > 0 ? (page.items[page.items.length - 1] as { id: string }).id : undefined;
      const more = page.items.length < docs.length || snapshot.size === limit;
      return ok({ collection: parent ? `${parent}/${parentId}/${name}` : name, documents: page.items, ...(more && lastId ? { nextCursor: Buffer.from(lastId, "utf-8").toString("base64url") } : {}) });
    }
  );
}
