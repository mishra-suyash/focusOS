/**
 * Standing habits from chat: commitments (timed recurring templates, e.g. a TA meeting or "Read daily
 * updates" at 08:00 every weekday) and routine blocks (Sleep, meals, Gym). Each write does what the app
 * does after the same change, so nothing is left for the next app visit to discover:
 * - a commitment's task occurrences for the next 14 days are generated (`generateRecurringTaskInstances`,
 *   the app's "Generate now"), and the calendar is pushed (timed commitments are calendar events);
 * - a commitment that would land on blocks already saved on a day is reported by name, since that day's
 *   next save would refuse the overlap;
 * - a routine edit is carried onto every saved day from today on with `resyncRoutineOnDay`, the rule the
 *   routine page's resync uses: fixed items win, unstarted planner sittings underneath go back to
 *   "to place", and anything placed by hand or already worked stays while the routine block steps aside.
 */
import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { saveDailySchedule, userCol } from "@/lib/admin-writes";
import { adminDb } from "@/lib/firebase-admin";
import { generateRecurringTaskInstances } from "@/lib/admin-recurring-tasks";
import { bucketWeeklyTarget, effectiveCourseStatus } from "@/lib/courses";
import { isScoredSitting } from "@/lib/gamify";
import { dayAsOpened } from "@/lib/mcp/day";
import { cleanPaperTitle, DEFAULT_READING_HABIT, derivePaperStatus, isThinPass, PASS_LABELS } from "@/lib/papers";
import { getDay, parseISO } from "date-fns";
import { addDaysToKey, weekDates } from "@/lib/dates";
import { pushCalendar, runWrite } from "@/lib/mcp/activity";
import { compact, fail, ok, type ToolContext } from "@/lib/mcp/context";
import { commitmentSlotsForDate, isFixedCommitment, isFixedCommitmentOccurrence, isTemplateDueOn } from "@/lib/recurring-tasks";
import { DEFAULT_ROUTINE_BLOCKS, resyncRoutineOnDay, routineSlotsForDate } from "@/lib/routine";
import { isFixedSlot, minutesFromTime, slotDuration } from "@/lib/schedule";
import { DEFAULT_WORKING_WINDOW, weekCapacity, weeklyPlanningSlotForDate } from "@/lib/weekplan";
import type { Course, DailySchedule, Day, Goal, Paper, PaperNote, Pass1Output, Pass2Output, Task, NewRecurringTaskTemplate, PomodoroSession, RecurringTaskTemplate, RevisionItem, RoutineBlock, WeekPlan, WeeklyReview } from "@/types";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm");
const idempotencyKey = z.string().max(200).optional().describe("Optional. Repeating a call with the same key returns the first result instead of writing twice.");
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).describe("0 = Sunday … 6 = Saturday.");
const needsWrite = requireScopes("read", "write");
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function commitmentView(template: RecurringTaskTemplate) {
  return compact({
    id: template.id,
    title: template.title,
    daysOfWeek: template.daysOfWeek,
    cadence: template.cadence,
    time: template.time ? `${template.time.startTime}–${template.time.endTime}` : undefined,
    location: template.time?.location,
    active: template.active,
    courseId: template.courseId,
    bucket: template.bucket,
    kind: isFixedCommitment(template) ? "fixed (on the calendar at its time, not a scored sitting)" : template.time ? "planned work at a set time (counts in its course bucket)" : "a recurring task with no clock time",
    startDate: template.startDate,
    endDate: template.endDate
  });
}

/** Saved days in the next 14 days where this commitment would land on a block someone placed. */
async function clashesOnSavedDays(ctx: ToolContext, template: RecurringTaskTemplate) {
  if (!isFixedCommitment(template)) return [];
  const today = (await ctx.frame()).scheduleDay;
  const schedules = (await ctx.list<DailySchedule>("dailySchedules")).filter((s) => s.dateKey >= today && s.dateKey <= addDaysToKey(today, 13));
  const clashes: string[] = [];
  for (const schedule of schedules) {
    if (!isTemplateDueOn(template, schedule.dateKey)) continue;
    const [slot] = commitmentSlotsForDate([template], schedule.dateKey, schedule.slots);
    if (!slot) continue;
    const start = minutesFromTime(slot.startTime);
    const end = minutesFromTime(slot.endTime);
    for (const other of schedule.slots) {
      if (other.id.startsWith("routine-")) continue; // routine steps aside for a commitment
      if (start < minutesFromTime(other.endTime) && minutesFromTime(other.startTime) < end) clashes.push(`${schedule.dateKey} ${other.startTime}–${other.endTime} ${other.title}${isFixedSlot(other) ? " (fixed)" : ""}`);
    }
  }
  return clashes;
}

export function registerRoutineTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_routine",
    {
      title: "List routine and commitments",
      description: "The person's routine blocks (Sleep, meals, Gym, custom; locked on every day they apply to), the weekly-planning anchor, and their commitments (recurring templates, timed or not), with ids for update_routine and update_commitment.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const settings = await ctx.settings();
      const templates = await ctx.list<RecurringTaskTemplate>("recurringTaskTemplates");
      return ok({
        routineBlocks: (settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS).map((block) => compact({ ...block, daysOfWeek: block.daysOfWeek })),
        weeklyPlanning: settings.weeklyPlanning,
        commitments: templates.filter((t) => !t.generatedFrom).map(commitmentView),
        autoRevisionTemplates: templates.filter((t) => t.generatedFrom).length || undefined
      });
    }
  );

  server.registerTool(
    "create_commitment",
    {
      title: "Add a standing commitment",
      description:
        "Adds something that recurs on set weekdays, e.g. \"Read daily updates\" 08:00–08:20 Mon–Fri or a TA meeting Thursdays 14:00–15:00. With startTime/endTime and no bucket it is a fixed commitment: a locked block on every matching day and a calendar event, not a scored sitting. Give courseId + bucket to make it planned course work at that time instead. Without a time it is a recurring task. Its task occurrences for the next 14 days are created; blocks already saved where it lands are listed as clashes to move.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        daysOfWeek: days,
        cadence: z.enum(["weekly", "biweekly"]).optional(),
        startTime: clock.optional(),
        endTime: clock.optional(),
        location: z.string().max(200).optional(),
        courseId: z.string().optional(),
        bucket: z.enum(["goal", "assignment", "backlog", "revision"]).optional(),
        category: z.enum(["research", "coding", "writing", "reading", "admin", "personal"]).optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        estimatedSessions: z.number().int().min(1).max(12).optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ idempotencyKey: key, ...input }) =>
      runWrite(ctx, "create_commitment", key, async () => {
        if (Boolean(input.startTime) !== Boolean(input.endTime)) return fail("Give both startTime and endTime, or neither.");
        if (input.startTime && minutesFromTime(input.endTime!) <= minutesFromTime(input.startTime)) return fail("A commitment must end after it starts (no crossing midnight).");
        if (input.bucket && !input.courseId) return fail("A bucket only means something on course work: pass courseId too.");
        const frame = await ctx.frame();
        let course: Course | null = null;
        if (input.courseId) {
          course = await ctx.get<Course>("courses", input.courseId);
          if (!course) return fail(`No course with id ${input.courseId}.`);
          const status = effectiveCourseStatus(course, frame.today);
          if (status !== "active") return fail(`"${course.name}" is ${status}; commitments can only be tied to an active course.`);
        }
        const cadence = input.cadence ?? "weekly";
        const template: NewRecurringTaskTemplate = {
          title: input.title.trim(),
          category: input.category ?? "admin",
          priority: input.priority ?? "medium",
          estimatedPomodoros: input.estimatedSessions,
          cadence,
          daysOfWeek: [...new Set(input.daysOfWeek)].sort(),
          anchorDate: cadence === "biweekly" ? frame.today : undefined,
          time: input.startTime ? { startTime: input.startTime, endTime: input.endTime!, ...(input.location ? { location: input.location } : {}) } : undefined,
          active: true,
          courseId: input.courseId,
          bucket: input.bucket,
          startDate: course?.startDate,
          endDate: course?.endDate
        };
        const nowIso = new Date().toISOString();
        const ref = userCol(ctx.uid, "recurringTaskTemplates").doc();
        await ref.set(JSON.parse(JSON.stringify({ ...template, createdAt: nowIso, updatedAt: nowIso })));
        ctx.meter.writes += 1;
        const saved = { ...template, id: ref.id, createdAt: nowIso, updatedAt: nowIso } as RecurringTaskTemplate;
        const generated = await generateRecurringTaskInstances(ctx.uid, frame.today, addDaysToKey(frame.today, 13));
        const clashes = await clashesOnSavedDays(ctx, saved);
        const calendar = template.time ? await pushCalendar(ctx.uid) : undefined;
        return {
          result: compact({
            created: commitmentView(saved),
            taskOccurrencesGenerated: generated.created ? `${generated.created} (every active commitment, next 14 days)` : undefined,
            clashes: clashes.length > 0 ? { note: "These saved blocks overlap the new commitment; move or remove them (move_block / apply_plan) or that day can't be saved.", blocks: clashes } : undefined,
            calendar
          }),
          changes: [{ targetType: "commitment", targetId: ref.id, title: saved.title, before: null, after: commitmentView(saved) }]
        };
      })
  );

  server.registerTool(
    "update_commitment",
    {
      title: "Change or pause a commitment",
      description: "Changes a commitment's title, days, time or location, or pauses it (active: false) / resumes it. A paused commitment stops appearing on days and on the calendar; occurrences already created stay as tasks.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        daysOfWeek: days.optional(),
        startTime: clock.optional(),
        endTime: clock.optional(),
        location: z.string().max(200).nullable().optional(),
        active: z.boolean().optional(),
        idempotencyKey
      }),
      annotations: { ...WRITE, idempotentHint: true },
      scopeChallenge: needsWrite
    },
    async ({ id, idempotencyKey: key, ...input }) =>
      runWrite(ctx, "update_commitment", key, async () => {
        const template = await ctx.get<RecurringTaskTemplate>("recurringTaskTemplates", id);
        if (!template) return fail(`No commitment with id ${id}.`);
        if (template.generatedFrom) return fail(`"${template.title}" is generated from a course's revision hours; change those on the course instead.`);
        const time = input.startTime || input.endTime || input.location !== undefined
          ? { startTime: input.startTime ?? template.time?.startTime, endTime: input.endTime ?? template.time?.endTime, location: input.location === null ? undefined : (input.location ?? template.time?.location) }
          : template.time;
        if (time && (!time.startTime || !time.endTime)) return fail("This commitment has no time yet; give both startTime and endTime.");
        if (time && minutesFromTime(time.endTime!) <= minutesFromTime(time.startTime!)) return fail("A commitment must end after it starts.");
        const after: RecurringTaskTemplate = {
          ...template,
          ...(input.title ? { title: input.title.trim() } : {}),
          ...(input.daysOfWeek ? { daysOfWeek: [...new Set(input.daysOfWeek)].sort() } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          time: time ? JSON.parse(JSON.stringify(time)) : undefined,
          updatedAt: new Date().toISOString()
        };
        const { id: _id, ...doc } = after;
        await userCol(ctx.uid, "recurringTaskTemplates").doc(id).set(JSON.parse(JSON.stringify(doc)));
        ctx.meter.writes += 1;
        const frame = await ctx.frame();
        const generated = after.active ? await generateRecurringTaskInstances(ctx.uid, frame.today, addDaysToKey(frame.today, 13)) : { created: 0 };
        const clashes = after.active ? await clashesOnSavedDays(ctx, after) : [];
        const calendar = template.time || after.time ? await pushCalendar(ctx.uid) : undefined;
        return {
          result: compact({ updated: commitmentView(after), taskOccurrencesGenerated: generated.created || undefined, clashes: clashes.length > 0 ? clashes : undefined, calendar }),
          changes: [{ targetType: "commitment", targetId: id, title: after.title, before: commitmentView(template), after: commitmentView(after) }]
        };
      })
  );

  server.registerTool(
    "update_routine",
    {
      title: "Add, change or remove a routine block",
      description:
        "Routine blocks are personal anchors (Sleep, meals, Gym, or custom) locked onto every day they apply to. Pass the block (match an existing one by id, or omit id to add one) or remove: true. endTime before startTime crosses midnight (Sleep 23:00→07:00). The change is carried onto every saved day from today on, as the app does: fixed items win, unstarted planner sittings under the new time go back to \"to place\", and blocks placed by hand stay while the routine block steps aside that day.",
      inputSchema: z.object({
        id: z.string().max(60).optional(),
        label: z.string().min(1).max(80).optional(),
        type: z.enum(["sleep", "meal", "gym", "break", "commute", "free", "custom"]).optional(),
        startTime: clock.optional(),
        endTime: clock.optional(),
        daysOfWeek: days.nullable().optional().describe("null = every day."),
        enabled: z.boolean().optional(),
        remove: z.boolean().optional(),
        idempotencyKey
      }),
      annotations: { ...WRITE, destructiveHint: true },
      scopeChallenge: needsWrite
    },
    async ({ idempotencyKey: key, ...input }) =>
      runWrite(ctx, "update_routine", key, async () => {
        const settings = await ctx.settings();
        const blocks = settings.routineBlocks ?? DEFAULT_ROUTINE_BLOCKS;
        const existing = input.id ? blocks.find((block) => block.id === input.id) : undefined;
        if (input.id && !existing && input.remove) return fail(`No routine block ${input.id}.`);
        let next: RoutineBlock[];
        let changed: RoutineBlock | null = null;
        if (input.remove) {
          next = blocks.filter((block) => block.id !== input.id);
        } else {
          const base: Partial<RoutineBlock> = existing ?? {};
          const block: RoutineBlock = {
            id: existing?.id ?? input.id ?? `custom-${Date.now().toString(36)}`,
            label: input.label ?? base.label ?? "",
            type: input.type ?? base.type ?? "custom",
            startTime: input.startTime ?? base.startTime ?? "",
            endTime: input.endTime ?? base.endTime ?? "",
            enabled: input.enabled ?? base.enabled ?? true,
            ...(input.daysOfWeek === null ? {} : input.daysOfWeek ? { daysOfWeek: [...new Set(input.daysOfWeek)].sort() } : base.daysOfWeek ? { daysOfWeek: base.daysOfWeek } : {})
          };
          if (!block.label || !block.startTime || !block.endTime) return fail("A new routine block needs label, startTime and endTime.");
          if (block.startTime === block.endTime) return fail("A routine block can't start and end at the same time.");
          changed = block;
          next = existing ? blocks.map((b) => (b.id === existing.id ? block : b)) : [...blocks, block];
        }
        await userCol(ctx.uid, "meta").doc("settings").set({ routineBlocks: JSON.parse(JSON.stringify(next)), updatedAt: new Date().toISOString() }, { merge: true });
        ctx.meter.writes += 1;

        // Carry it onto saved days, as the routine page's resync does.
        const frame = await ctx.frame();
        const [schedules, sessions] = await Promise.all([ctx.list<DailySchedule>("dailySchedules"), ctx.list<PomodoroSession>("pomodoroSessions")]);
        const clockState = { todayKey: frame.scheduleDay, nowMinutes: frame.minute, sessions };
        const dayChanges: string[] = [];
        const released: string[] = [];
        const steppedAside: string[] = [];
        for (const schedule of schedules) {
          if (schedule.dateKey < frame.scheduleDay) continue;
          const anchor = weeklyPlanningSlotForDate(settings.weeklyPlanning, schedule.dateKey);
          const wanted = [...routineSlotsForDate(next, schedule.dateKey), ...(anchor ? [anchor] : [])];
          const result = resyncRoutineOnDay({ dateKey: schedule.dateKey, slots: schedule.slots, wanted, clock: clockState });
          if (!result) continue;
          await saveDailySchedule(ctx.uid, { dateKey: schedule.dateKey, templateId: schedule.templateId, slots: result.slots });
          ctx.meter.writes += 1;
          dayChanges.push(schedule.dateKey);
          released.push(...result.released.map((slot) => `${schedule.dateKey} ${slot.startTime}–${slot.endTime} ${slot.title}`));
          steppedAside.push(...result.steppedAside.map((title) => `${schedule.dateKey} ${title}`));
        }
        const calendar = released.length > 0 ? await pushCalendar(ctx.uid) : undefined;
        return {
          result: compact({
            routine: input.remove ? { removed: input.id } : changed,
            savedDaysUpdated: dayChanges,
            sittingsBackToPlace: released.length > 0 ? { note: "Unstarted planner sittings under the new time were taken off; the weekly planner offers them again.", blocks: released } : undefined,
            steppedAside: steppedAside.length > 0 ? { note: "The routine block stepped aside on these days for something placed by hand or already worked.", blocks: steppedAside } : undefined,
            calendar
          }),
          changes: [{ targetType: "routine", targetId: input.id ?? changed?.id ?? "", title: changed?.label ?? existing?.label, before: existing ? { ...existing } : null, after: input.remove ? null : { ...changed } }]
        };
      })
  );

  server.registerTool(
    "defer_revision",
    {
      title: "Push revision back",
      description:
        "Moves due revision cards later without reviewing them (their ladder step, reps and lapses are unchanged). until: a crunch day with no revision: every card due on or before that date moves to the day after it, so it adds nothing to Workload, Up next or planning until then. days: push the cards due now by that many days. itemIds narrows it to some cards. Revision blocks already on the plan are listed, not removed.",
      inputSchema: z.object({
        until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        days: z.number().int().min(1).max(30).optional(),
        itemIds: z.array(z.string()).max(200).optional(),
        idempotencyKey
      }),
      annotations: { ...WRITE, idempotentHint: true },
      scopeChallenge: needsWrite
    },
    async ({ until, days: byDays, itemIds, idempotencyKey: key }) =>
      runWrite(ctx, "defer_revision", key, async () => {
        if (Boolean(until) === Boolean(byDays)) return fail("Give either until (a date) or days (a number), not both.");
        const today = (await ctx.frame()).today;
        if (until && until < today) return fail(`${until} has passed.`);
        const cutoff = until ?? today;
        const newDue = until ? addDaysToKey(until, 1) : addDaysToKey(today, byDays!);
        const items = (await ctx.list<RevisionItem>("revisionItems")).filter((item) => !item.suspended && !item.retiredAt && item.dueDate <= cutoff && (!itemIds || itemIds.includes(item.id)));
        if (items.length === 0) return { result: { unchanged: `No revision cards are due on or before ${cutoff}.` }, changes: [] };
        const nowIso = new Date().toISOString();
        for (let i = 0; i < items.length; i += 400) {
          const batch = adminDb().batch();
          for (const item of items.slice(i, i + 400)) batch.update(userCol(ctx.uid, "revisionItems").doc(item.id), { dueDate: newDue, updatedAt: nowIso });
          await batch.commit();
        }
        ctx.meter.writes += items.length;
        const schedules = (await ctx.list<DailySchedule>("dailySchedules")).filter((s) => s.dateKey >= today && s.dateKey <= cutoff);
        const revisionBlocks = schedules.flatMap((s) => s.slots.filter((slot) => slot.objectiveRef?.kind === "revisionQueue").map((slot) => `${s.dateKey} ${slot.startTime}–${slot.endTime} ${slot.title} (slotId ${slot.id})`));
        return {
          result: compact({
            deferred: items.length,
            nowDue: newDue,
            cards: items.slice(0, 30).map((item) => `${item.title} (was due ${item.dueDate})`),
            revisionBlocksStillPlanned: revisionBlocks.length > 0 ? { note: "These revision blocks now have nothing due; remove them with remove_block if the time should go elsewhere.", blocks: revisionBlocks } : undefined
          }),
          changes: items.map((item) => ({ targetType: "revisionItem", targetId: item.id, title: item.title, before: { dueDate: item.dueDate }, after: { dueDate: newDue } }))
        };
      })
  );

  server.registerTool(
    "commit_week",
    {
      title: "Commit a week's plan",
      description:
        "Marks a week (weekStart = its Monday) as committed, as /plan/week's Commit does: the courses' weekly targets, the capacity, and the reading habit are snapshotted, and what's on the calendar that week (including blocks placed from chat) is recorded as committed. Proposals the planner hadn't placed yet and dismissals are kept. It does not run the planner or add sittings: place them first (add_block, add_session, plan_lead_up). recommit: true updates an already-committed week.",
      inputSchema: z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), recommit: z.boolean().optional(), idempotencyKey }),
      annotations: { ...WRITE, idempotentHint: true },
      scopeChallenge: needsWrite
    },
    async ({ weekStart, recommit, idempotencyKey: key }) =>
      runWrite(ctx, "commit_week", key, async () => {
        if (getDay(parseISO(weekStart)) !== 1) return fail(`${weekStart} isn't a Monday; weekStart is the week's Monday.`);
        const frame = await ctx.frame();
        const dates = weekDates(weekStart);
        if (dates[6] < frame.today) return fail(`The week of ${weekStart} is over.`);
        const review = await ctx.get<WeeklyReview>("weeklyReviews", weekStart);
        if (review?.plan?.completedAt && !recommit) return { result: { unchanged: `The week of ${weekStart} was already committed on ${review.plan.completedAt.slice(0, 10)}. Pass recommit: true to update it.` }, changes: [] };
        const settings = await ctx.settings();
        const [courses, goals] = await Promise.all([ctx.list<Course>("courses"), ctx.list<Goal>("goals")]);
        const active = courses.filter((course) => dates.some((d) => effectiveCourseStatus(course, d) === "active"));
        const activeGoals = goals.filter((goal) => goal.status === "active");
        const targets = active.flatMap((course) =>
          (["revision", "assignment", "backlog", "goal"] as const).map((bucket) => ({ courseId: course.id, bucket, minutes: bucketWeeklyTarget(course, bucket, activeGoals.filter((goal) => goal.linked.courseIds.includes(course.id))) }))
        );
        const days = await Promise.all(dates.map(async (d) => ({ d, slots: await dayAsOpened(ctx, d, (await ctx.get<DailySchedule>("dailySchedules", d))?.slots ?? []), day: await ctx.get<Day>("days", d) })));
        const offDateKeys = new Set(days.filter((x) => x.day?.dayOff).map((x) => x.d));
        const committedMinutes = targets.reduce((sum, t) => sum + t.minutes, 0);
        const capacity = weekCapacity({ workingWindow: settings.workingWindow ?? DEFAULT_WORKING_WINDOW, weekDateKeys: dates, claimedSlotsByDate: Object.fromEntries(days.map((x) => [x.d, x.slots])), committedMinutes, offDateKeys, now: { dateKey: frame.scheduleDay, minutes: frame.minute } });
        const sittingsByDay = Object.fromEntries(days.map((x) => [x.d, x.slots.filter(isScoredSitting).length]).filter(([, n]) => (n as number) > 0));
        const minutes = days.flatMap((x) => x.slots.filter(isScoredSitting)).reduce((sum, slot) => sum + slotDuration(slot), 0);
        const plan: WeekPlan = {
          ...(review?.plan ?? {}),
          targets,
          capacity,
          proposedBlocks: review?.plan?.proposedBlocks ?? [],
          readingTarget: settings.readingHabit ?? DEFAULT_READING_HABIT,
          completedAt: new Date().toISOString(),
          committedFrom: "chat",
          placedAtCommit: { sittings: Object.values(sittingsByDay).reduce((a, b) => (a as number) + (b as number), 0) as number, minutes, byDay: sittingsByDay as Record<string, number> }
        };
        const nowIso = new Date().toISOString();
        await userCol(ctx.uid, "weeklyReviews").doc(weekStart).set(JSON.parse(JSON.stringify({ weekStart, updatedAt: nowIso, ...(review ? {} : { createdAt: nowIso }), plan })), { merge: true });
        ctx.meter.writes += 1;
        return {
          result: compact({
            committed: weekStart,
            sittingsOnCalendar: plan.placedAtCommit,
            capacity: { freeHours: Math.round((capacity.freeMinutes / 60) * 10) / 10, targetHours: Math.round((committedMinutes / 60) * 10) / 10 },
            unplacedProposalsKept: plan.proposedBlocks.length || undefined,
            note: "Committed as it stands on the calendar. Work the planner still has \"to place\" isn't proposed on a committed week; Replan in /plan/week (or more add_block / add_session calls) places it."
          }),
          changes: [{ targetType: "weekPlan", targetId: weekStart, title: `Week of ${weekStart}`, before: { committed: Boolean(review?.plan?.completedAt) }, after: { committed: true } }]
        };
      })
  );

  server.registerTool(
    "get_meeting_prep",
    {
      title: "Material for a supervisor meeting",
      description:
        "Everything since the last meeting (default: the last 7 days) worth putting on an agenda: paper passes finished (with any key points and the questions left open), notes marked question or critique, tasks finished, open high-priority and overdue tasks, and goal milestones due soon or overdue. Read-only and deterministic: draft the agenda from it in chat, then store it on the meeting block (update_block agenda) and turn agreed action items into tasks (create_task) and onto the block (update_block actionItems).",
      inputSchema: z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ since, until }) => {
      const frame = await ctx.frame();
      const from = since ?? addDaysToKey(frame.today, -7);
      const to = until ?? frame.today;
      const within = (iso?: string) => Boolean(iso) && frame.at(iso!) >= from && frame.at(iso!) <= to;
      const [papers, allTasks, goals, templates] = await Promise.all([ctx.list<Paper>("papers"), ctx.list<Task>("tasks"), ctx.list<Goal>("goals"), ctx.list<RecurringTaskTemplate>("recurringTaskTemplates")]);
      // An occurrence of a fixed commitment (a TA meeting) is time on the calendar, not something to report on.
      const tasks = allTasks.filter((task) => !isFixedCommitmentOccurrence(task, templates));
      const passesFinished = papers.flatMap((paper) =>
        ([1, 2, 3] as const)
          .filter((n) => paper[`pass${n}` as const]?.status === "done" && within(paper[`pass${n}` as const]?.completedAt))
          .map((n) => {
            const output = paper[`pass${n}` as const]?.output as (Pass1Output & Pass2Output) | undefined;
            return compact({
              paper: cleanPaperTitle(paper),
              pass: PASS_LABELS[n],
              thin: isThinPass(n, paper[`pass${n}` as const]) ? true : undefined,
              contributions: n === 1 ? output?.contributions : undefined,
              keyPoints: n === 2 ? output?.keyPoints : undefined,
              summary: n === 2 ? output?.summary : undefined,
              openQuestions: n === 2 ? output?.unclear : undefined
            });
          })
      );
      const active = papers.filter((paper) => ["reading", "read"].includes(derivePaperStatus(paper)) || paper.queuedAt);
      const notes = (await Promise.all(active.slice(0, 25).map(async (paper) => (await ctx.sub<PaperNote>("papers", paper.id, "notes")).map((note) => ({ note, paper })))))
        .flat()
        .filter(({ note }) => (note.kind === "question" || note.kind === "critique") && within(note.createdAt))
        .map(({ note, paper }) => ({ paper: cleanPaperTitle(paper), kind: note.kind, note: note.body }));
      const open = tasks.filter((task) => task.status !== "done");
      return ok(
        compact({
          period: `${from} to ${to}`,
          passesFinished,
          questionsAndCritiques: notes,
          tasksDone: tasks.filter((task) => task.status === "done" && within(task.completedAt)).map((task) => task.title),
          openPriorities: open.filter((task) => task.priority === "high" || (task.dueDate && task.dueDate < frame.today)).map((task) => compact({ title: task.title, due: task.dueDate, overdue: task.dueDate && task.dueDate < frame.today ? true : undefined })),
          milestones: goals
            .filter((goal) => goal.status === "active")
            .flatMap((goal) => goal.milestones.filter((m) => !m.done && m.dueAt && m.dueAt.slice(0, 10) <= addDaysToKey(frame.today, 14)).map((m) => ({ goal: goal.title, milestone: m.title, due: m.dueAt!.slice(0, 10), overdue: m.dueAt!.slice(0, 10) < frame.today })))
        })
      );
    }
  );
}
