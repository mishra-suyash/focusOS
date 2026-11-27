/**
 * plan/19 §5.2 Phase 4 — editing a day's blocks, the writes with the most invariants:
 * - a block is addressed by date + slotId (recurring class/routine slots reuse ids on every date);
 * - the locked and fixed layers (classes, routine, imported events, commitments, the planning anchor)
 *   are never moved or removed;
 * - a sitting stays inside the person's sitting bounds, or it could never reach the 60% that closes it;
 * - nothing that has started or finished is touched, and nothing is placed in the past;
 * - a day never saved before is built the way `/plan/week` builds one (`daySlotsWithFixed`): its classes,
 *   commitments, routine and planning anchor, so the first write can't produce a day missing its classes.
 *   No template is applied: in the app a template lands only through Start day or an explicit Apply;
 * - every save carries a fresh `updatedAt`, so an open `/plan/day` tab raises its conflict instead of
 *   autosaving over the change, and then the Google Calendar push the autosave would have triggered.
 */
import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { saveDailySchedule } from "@/lib/admin-writes";
import { isFromDroppedCourse, effectiveCourseStatus } from "@/lib/courses";
import { isScoredSitting } from "@/lib/gamify";
import { diff, pushCalendar, runWrite } from "@/lib/mcp/activity";
import { compact, fail, type ToolContext } from "@/lib/mcp/context";
import { dayAsOpened } from "@/lib/mcp/day";
import { blockView, blocksView } from "@/lib/mcp/views";
import { createSlot, isFixedSlot, isLockedSlot, minutesFromTime, slotDuration, sortedSlots, validateSlots } from "@/lib/schedule";
import { sittingBounds } from "@/lib/timeline";
import { slotCoverageMinutes } from "@/lib/tracking";
import type { Course, DailySchedule, Day, PomodoroSession, ScheduleSlot, Task } from "@/types";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-MM-dd");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm");
const idempotencyKey = z.string().max(200).optional().describe("Optional. Repeating a call with the same key returns the first result instead of writing twice.");
/** Block types Claude may place. Classes come from courses and external blocks from Google Calendar. */
const placeable = z.enum(["deep_work", "reading", "admin", "meal", "free", "break", "commute", "sleep", "gym", "custom"]);
const needsWrite = requireScopes("read", "write");

interface DayContext {
  schedule: DailySchedule | null;
  slots: ScheduleSlot[];
  sessionsOnDate: PomodoroSession[];
  isClockDay: boolean;
  minute: number;
  scheduleDay: string;
}

/** Past dates, closed days, and (today) the part of the day already gone are read-only. */
async function openDay(ctx: ToolContext, date: string): Promise<DayContext | string> {
  const frame = await ctx.frame();
  if (date < frame.scheduleDay) return "That date has passed; past days are read-only through this connection.";
  const [schedule, day, sessions] = await Promise.all([ctx.get<DailySchedule>("dailySchedules", date), ctx.get<Day>("days", date), ctx.list<PomodoroSession>("pomodoroSessions")]);
  if (day?.closedAt || day?.session?.endedAt) return `${date} is already closed (ended or wrapped up), so its plan is read-only.`;
  const slots = await dayAsOpened(ctx, date, schedule?.slots ?? []);
  return { schedule, slots, sessionsOnDate: sessions.filter((s) => frame.slotDay(s) === date), isClockDay: date === frame.scheduleDay, minute: frame.minute, scheduleDay: frame.scheduleDay };
}

/** A block Claude may move or remove: placed by the person or the planner, not started, not finished. */
function editableRefusal(slot: ScheduleSlot, day: DayContext): string | null {
  if (isLockedSlot(slot) || slot.id.startsWith("routine-")) return `"${slot.title}" is part of the locked layer (a class, routine block or calendar event) and can't be moved or removed.`;
  if (isFixedSlot(slot) || slot.id === "weekly-planning") return `"${slot.title}" is a fixed commitment and can't be moved or removed here.`;
  if (slot.status !== "upcoming") return `"${slot.title}" is marked ${slot.status}; finished blocks are part of the day's record.`;
  if (day.isClockDay && minutesFromTime(slot.startTime) <= day.minute) return `"${slot.title}" has already started; its coverage history depends on where it is.`;
  if (slotCoverageMinutes(slot, day.sessionsOnDate) > 0) return `"${slot.title}" already has focus time logged against it.`;
  return null;
}

/** A sitting outside the bounds could never close: the timer is clamped to the cap, and closing needs 60% coverage. */
async function boundsRefusal(ctx: ToolContext, slot: Pick<ScheduleSlot, "type" | "startTime" | "endTime" | "title">): Promise<string | null> {
  if (!isScoredSitting(slot)) return null;
  const { maxChunkMinutes, minChunkMinutes } = sittingBounds(await ctx.settings());
  const minutes = minutesFromTime(slot.endTime) - minutesFromTime(slot.startTime);
  if (minutes > maxChunkMinutes) return `A sitting can be at most ${maxChunkMinutes} minutes (this one is ${minutes}). Split the work into several blocks of ${minChunkMinutes}–${maxChunkMinutes} minutes.`;
  if (minutes < minChunkMinutes) return `A sitting must be at least ${minChunkMinutes} minutes (this one is ${minutes}).`;
  return null;
}

async function save(ctx: ToolContext, date: string, day: DayContext, slots: ScheduleSlot[]) {
  const errors = validateSlots(slots);
  if (errors.length > 0) return { errors };
  const { updatedAt } = await saveDailySchedule(ctx.uid, { dateKey: date, templateId: day.schedule?.templateId, slots: sortedSlots(slots) });
  ctx.meter.writes += 1;
  const calendar = await pushCalendar(ctx.uid);
  return { updatedAt, calendar };
}

export function registerScheduleTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "add_block",
    {
      title: "Add a block to a day",
      description:
        "Places one block on a date (today or later, never in the past). A sitting (deep_work, reading, admin) must fit the person's sitting bounds; for longer work add several blocks. The block may not overlap anything already there. A date never planned gets its classes, commitments and routine first, as the app would show it. Classes and calendar events can't be added here.",
      inputSchema: z.object({
        date: dateKey,
        title: z.string().min(1).max(200),
        type: placeable,
        startTime: clock,
        endTime: clock,
        taskIds: z.array(z.string()).max(10).optional().describe("Tasks this block is for."),
        courseId: z.string().optional(),
        bucket: z.enum(["goal", "assignment", "backlog", "revision"]).optional(),
        note: z.string().max(500).optional(),
        idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, title, type, startTime, endTime, taskIds, courseId, bucket, note, idempotencyKey: key }) =>
      runWrite(ctx, "add_block", key, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        if (minutesFromTime(endTime) <= minutesFromTime(startTime)) return fail("A block must end after it starts (blocks can't cross midnight).");
        if (day.isClockDay && minutesFromTime(startTime) < day.minute) return fail(`It's already past ${startTime} today; place the block later.`);
        const tooLong = await boundsRefusal(ctx, { type, startTime, endTime, title });
        if (tooLong) return fail(tooLong);
        if (bucket && !courseId) return fail("A bucket only means something on course work: pass courseId too.");
        const courses = await ctx.list<Course>("courses");
        if (courseId) {
          const course = courses.find((c) => c.id === courseId);
          if (!course) return fail(`No course with id ${courseId}.`);
          const status = effectiveCourseStatus(course, (await ctx.frame()).today);
          if (status !== "active") return fail(`"${course.name}" is ${status}; blocks can only be planned for an active course.`);
        }
        if (taskIds?.length) {
          const tasks = await ctx.list<Task>("tasks");
          for (const id of taskIds) {
            const task = tasks.find((t) => t.id === id);
            if (!task) return fail(`No task with id ${id}.`);
            if (task.status === "done") return fail(`"${task.title}" is already done.`);
            if (isFromDroppedCourse(task, courses)) return fail(`"${task.title}" belongs to a dropped course.`);
          }
        }
        const slot = createSlot({ title: title.trim(), type, startTime, endTime, assignedTaskIds: taskIds ?? [], courseId, bucket, note: note ?? "" });
        // plannedMinutes feeds plannedMinutesThisWeek, and so what the planner re-proposes next week.
        slot.plannedMinutes = slotDuration(slot);
        const before = day.slots;
        const result = await save(ctx, date, day, [...before, slot]);
        if ("errors" in result) return fail(`Not placed: ${result.errors!.join(" ")}`);
        const view = { dateKey: date, scheduleDay: day.scheduleDay, minute: day.minute, sessionsOnDate: day.sessionsOnDate };
        return {
          result: compact({
            added: blockView(slot, view),
            date,
            builtDay: day.schedule ? undefined : "This date had no saved plan, so it was created with its classes, commitments and routine.",
            calendar: result.calendar
          }),
          changes: [{ targetType: "block", targetId: `${date}/${slot.id}`, title: slot.title, before: null, after: { date, startTime, endTime, type } }]
        };
      })
  );

  server.registerTool(
    "move_block",
    {
      title: "Move or resize a block",
      description:
        "Changes a block's start and end time on the same date. Address it by date and slotId (from get_day). Refused for classes, routine, calendar events and commitments, for blocks that have started, finished or have focus time on them, for times already past, and for sittings outside the sitting bounds.",
      inputSchema: z.object({ date: dateKey, slotId: z.string(), startTime: clock, endTime: clock, idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, slotId, startTime, endTime, idempotencyKey: key }) =>
      runWrite(ctx, "move_block", key, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const slot = day.schedule?.slots.find((s) => s.id === slotId) ?? day.slots.find((s) => s.id === slotId);
        if (!slot) return fail(`No block ${slotId} on ${date}.`);
        const refused = editableRefusal(slot, day);
        if (refused) return fail(refused);
        if (minutesFromTime(endTime) <= minutesFromTime(startTime)) return fail("A block must end after it starts (blocks can't cross midnight).");
        if (day.isClockDay && minutesFromTime(startTime) < day.minute) return fail(`It's already past ${startTime} today.`);
        const moved = { ...slot, startTime, endTime };
        const tooLong = await boundsRefusal(ctx, moved);
        if (tooLong) return fail(tooLong);
        const result = await save(ctx, date, day, day.slots.map((s) => (s.id === slotId ? moved : s)));
        if ("errors" in result) return fail(`Not moved: ${result.errors!.join(" ")}`);
        const view = { dateKey: date, scheduleDay: day.scheduleDay, minute: day.minute, sessionsOnDate: day.sessionsOnDate };
        return {
          result: compact({ moved: blockView(moved, view), from: `${slot.startTime}–${slot.endTime}`, calendar: result.calendar }),
          changes: [{ targetType: "block", targetId: `${date}/${slotId}`, title: slot.title, ...diff(slot, moved, ["startTime", "endTime"]) }]
        };
      })
  );

  server.registerTool(
    "remove_block",
    {
      title: "Remove a block",
      description: "Takes one block off a date, addressed by date and slotId. Same refusals as move_block: never the locked or fixed layer, never a block that has started, finished or has focus time.",
      inputSchema: z.object({ date: dateKey, slotId: z.string(), idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, slotId, idempotencyKey: key }) =>
      runWrite(ctx, "remove_block", key, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const slot = day.schedule?.slots.find((s) => s.id === slotId);
        if (!slot) return fail(day.slots.some((s) => s.id === slotId) ? "That block is part of the fixed layer of the day and can't be removed." : `No block ${slotId} on ${date}.`);
        const refused = editableRefusal(slot, day);
        if (refused) return fail(refused);
        const result = await save(ctx, date, day, day.slots.filter((s) => s.id !== slotId));
        if ("errors" in result) return fail(`Not removed: ${result.errors!.join(" ")}`);
        const view = { dateKey: date, scheduleDay: day.scheduleDay, minute: day.minute, sessionsOnDate: day.sessionsOnDate };
        return {
          result: compact({ removed: { title: slot.title, startTime: slot.startTime, endTime: slot.endTime }, date, dayNow: blocksView(day.slots.filter((s) => s.id !== slotId), view).map((b) => ({ slotId: b.slotId, title: b.title, startTime: b.startTime, endTime: b.endTime })), calendar: result.calendar }),
          changes: [{ targetType: "block", targetId: `${date}/${slotId}`, title: slot.title, before: { date, startTime: slot.startTime, endTime: slot.endTime, type: slot.type }, after: null }]
        };
      })
  );
}
