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
import { requireScopes, type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { saveDailySchedule, userCol } from "@/lib/admin-writes";
import { isFromDroppedCourse, effectiveCourseStatus } from "@/lib/courses";
import { isScoredSitting } from "@/lib/gamify";
import { diff, pushCalendar, runWrite, type ActivityChange, type CalendarMode } from "@/lib/mcp/activity";
import { compact, fail, ok, type ToolContext } from "@/lib/mcp/context";
import { dayAsOpened } from "@/lib/mcp/day";
import { blockView, blocksView } from "@/lib/mcp/views";
import { createSlot, isFixedSlot, isLockedSlot, minutesFromTime, minutesToTime, slotDuration, sortedSlots, validateSlots } from "@/lib/schedule";
import { cleanPaperTitle, derivePaperStatus, nextReadingPass, PASS_LABELS, readingCandidates } from "@/lib/papers";
import { renumberSittings, sittingBounds, sittingTitle, splitIntoChunks } from "@/lib/timeline";
import { dayShapeConflict, dayShapeWindows, DEFAULT_MAX_SITTINGS_PER_DAY, DEFAULT_WORKING_WINDOW, energyOf, layOutBackwards, TIME_OF_DAY_WINDOWS, type LeadUpDay } from "@/lib/weekplan";
import { addDaysToKey } from "@/lib/dates";
import { getDay, parseISO } from "date-fns";
import { slotCoverageMinutes } from "@/lib/tracking";
import type { Checkpoint, Course, DailySchedule, Day, Goal, Paper, PomodoroSession, ScheduleSlot, SlotObjectiveRef, Task } from "@/types";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-MM-dd");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm");
const idempotencyKey = z.string().max(200).optional().describe("Optional. Repeating a call with the same key returns the first result instead of writing twice.");
/** Block types Claude may place. Classes come from courses and external blocks from Google Calendar. */
const placeable = z.enum(["deep_work", "reading", "admin", "meal", "free", "break", "commute", "sleep", "gym", "custom", "meeting"]);
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

const calendarMode = z
  .enum(["push", "skip", "dryRun"])
  .optional()
  .describe(
    'Default "push": save, then push to Google Calendar (the push reconciles the whole 14-day window; the result names anything created or removed on other dates). "skip": save without pushing. "dryRun": save nothing and return what would change on the day and in the calendar.'
  );

/** One day's edit, worked out but not yet saved: what the day would hold, what to tell Claude, and what to record. */
interface DayEdit {
  date: string;
  day: DayContext;
  slots: ScheduleSlot[];
  result: Record<string, unknown>;
  changes: ActivityChange[];
}

/**
 * Every schedule write goes through here, so the rules are applied once: the day is validated as a
 * whole (`validateSlots`: no overlaps, no fixed clashes), saved once with a fresh `updatedAt` (an open
 * `/plan/day` tab raises its conflict), then pushed once. A dry run stops before the save and the
 * activity record, and previews the push against the edited day instead.
 */
/**
 * Sittings are numbered by position ("1 of 3" is the first), as the app does (`renumberSittings`).
 * After a move, swap or removal, a split that sat wholly on this day before the edit is renumbered;
 * one that spans other days is left alone, since its other sittings aren't read here.
 */
function renumberDay(date: string, before: ScheduleSlot[], after: ScheduleSlot[]): ScheduleSlot[] {
  const counts = new Map<string, number>();
  for (const slot of before) if (slot.chunk) counts.set(slot.chunk.groupId, (counts.get(slot.chunk.groupId) ?? 0) + 1);
  const wholeHere = (slot: ScheduleSlot) => Boolean(slot.chunk && (counts.get(slot.chunk.groupId) ?? 0) >= slot.chunk.total);
  const entries = after.map((slot) => ({ ...slot, dateKey: date, chunk: wholeHere(slot) || !before.some((b) => b.chunk?.groupId === slot.chunk?.groupId) ? slot.chunk : undefined, _keep: slot.chunk }));
  return renumberSittings(entries).map(({ dateKey: _d, _keep, ...slot }) => (slot.chunk || !_keep ? (slot as ScheduleSlot) : ({ ...slot, chunk: _keep } as ScheduleSlot)));
}

/**
 * The day shape is a preference, not a rule the save enforces (the person may put deep work in the
 * evening on purpose), so a block that breaks it is saved and named: deep work in a light window or
 * outside the windows. Only blocks this edit placed or moved are checked.
 */
async function shapeWarnings(ctx: ToolContext, edit: DayEdit) {
  const settings = await ctx.settings();
  // A day past the sustainable number of sittings is saved, and said so (3.5).
  const cap = settings.maxSittingsPerDay ?? DEFAULT_MAX_SITTINGS_PER_DAY;
  const sittings = edit.slots.filter(isScoredSitting).length;
  const capWarning = sittings > cap && sittings > edit.day.slots.filter(isScoredSitting).length ? { sittingCapWarning: `${edit.date} now has ${sittings} sittings, over the sustainable ${cap} a day.` } : {};
  const windows = dayShapeWindows(settings.dayShape);
  if (!windows) return capWarning;
  const before = new Map(edit.day.slots.map((slot) => [slot.id, `${slot.startTime}-${slot.endTime}`]));
  const warnings = edit.slots
    .filter((slot) => before.get(slot.id) !== `${slot.startTime}-${slot.endTime}`)
    .map((slot) => {
      const conflict = dayShapeConflict(windows, slot);
      return conflict ? `${slotSummary(slot)}: ${conflict}` : null;
    })
    .filter((line): line is string => line !== null);
  return { ...capWarning, ...(warnings.length > 0 ? { dayShapeWarnings: warnings } : {}) };
}

async function scheduleWrite(ctx: ToolContext, tool: string, key: string | undefined, mode: CalendarMode | undefined, build: () => Promise<DayEdit | CallToolResult>): Promise<CallToolResult> {
  if (mode === "dryRun") {
    const edit = await build();
    if ("content" in edit) return edit;
    const numbered = renumberDay(edit.date, edit.day.slots, edit.slots);
    const renamed = numbered.filter((slot, i) => slot.title !== edit.slots[i].title).map((slot) => `${edit.slots.find((s) => s.id === slot.id)!.title} → ${slot.title}`);
    if (renamed.length > 0) edit.result = { ...edit.result, sittingsRenumbered: renamed };
    edit.slots = numbered;
    const errors = validateSlots(edit.slots);
    if (errors.length > 0) return fail(`Would be refused: ${errors.join(" ")}`);
    edit.result = { ...edit.result, ...(await shapeWarnings(ctx, edit)) };
    const calendar = await pushCalendar(ctx.uid, { mode, date: edit.date, override: { dateKey: edit.date, slots: sortedSlots(edit.slots) } });
    return ok(compact({ dryRun: "Nothing was saved. Call again without dryRun to make this change.", ...edit.result, calendar }));
  }
  return runWrite(ctx, tool, key, async () => {
    const edit = await build();
    if ("content" in edit) return edit;
    const numbered = renumberDay(edit.date, edit.day.slots, edit.slots);
    const renamed = numbered.filter((slot, i) => slot.title !== edit.slots[i].title).map((slot) => `${edit.slots.find((s) => s.id === slot.id)!.title} → ${slot.title}`);
    if (renamed.length > 0) edit.result = { ...edit.result, sittingsRenumbered: renamed };
    edit.slots = numbered;
    const errors = validateSlots(edit.slots);
    if (errors.length > 0) return fail(`Not saved: ${errors.join(" ")}`);
    edit.result = { ...edit.result, ...(await shapeWarnings(ctx, edit)) };
    const { updatedAt } = await saveDailySchedule(ctx.uid, { dateKey: edit.date, templateId: edit.day.schedule?.templateId, slots: sortedSlots(edit.slots) });
    ctx.meter.writes += 1;
    const calendar = await pushCalendar(ctx.uid, { mode, date: edit.date });
    return { result: compact({ ...edit.result, savedAt: updatedAt, calendar }), changes: edit.changes };
  });
}

/** A never-planned date is built before the first edit: say so, and name what the build put there. */
function builtDayNote(day: DayContext) {
  if (day.schedule) return undefined;
  return {
    note: "This date had no saved plan, so saving this edit also saved the day as the app shows it: its classes, commitments and routine blocks. Those are part of the day either way; FocusOS-made blocks among them are pushed to the calendar unless calendar is \"skip\".",
    blocks: day.slots.map((slot) => `${slot.startTime}–${slot.endTime} ${slot.title}`)
  };
}

function viewFor(date: string, day: DayContext) {
  return { dateKey: date, scheduleDay: day.scheduleDay, minute: day.minute, sessionsOnDate: day.sessionsOnDate };
}

const objectiveInput = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("paper"), paperId: z.string(), passNo: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("1 Skim, 2 Read, 3 Deep dive. Default: the paper's next pass.") }),
    z.object({ kind: z.literal("readingHabit") }).describe("An open reading sitting: the paper is picked when it starts."),
    z.object({ kind: z.literal("nextReading") }).describe("The next paper pass in the reading queue's order (in progress, then queued, then priority), resolved now so the block is titled e.g. \"Read: LithOS\". Change the pick later with update_block."),
    z.object({ kind: z.literal("revisionQueue") }).describe("Work the spaced-revision queue."),
    z.object({ kind: z.literal("checkpoint"), courseId: z.string(), checkpointId: z.string() }).describe("Prep for an assessment."),
    z.object({ kind: z.literal("goal"), goalId: z.string(), milestoneId: z.string().optional() })
  ])
  .describe("What the block is for. A paper objective makes focus time in the block count toward that paper's Reading time and pass, exactly like a sitting the weekly planner placed.");
type ObjectiveInput = z.infer<typeof objectiveInput>;

const blockFields = {
  title: z.string().min(1).max(200),
  type: placeable,
  startTime: clock,
  endTime: clock,
  taskIds: z.array(z.string()).max(10).optional().describe("Tasks this block is for."),
  courseId: z.string().optional(),
  bucket: z.enum(["goal", "assignment", "backlog", "revision"]).optional(),
  objective: objectiveInput.optional(),
  note: z.string().max(500).optional()
};

interface ResolvedObjective {
  objectiveRef: SlotObjectiveRef;
  /** The type the app gives a block for this objective. */
  type?: ScheduleSlot["type"];
  defaultTitle: string;
  courseId?: string;
}

/**
 * An objective is checked against the record it points at, the way the planner only proposes live
 * work: a paper that is still to read and a pass not already done, an assessment not yet handed in, an
 * active goal and an open milestone.
 */
async function resolveObjective(ctx: ToolContext, objective: ObjectiveInput): Promise<ResolvedObjective | string> {
  if (objective.kind === "readingHabit") return { objectiveRef: { kind: "readingHabit" }, type: "reading", defaultTitle: "Reading" };
  if (objective.kind === "nextReading") {
    const papers = await ctx.list<Paper>("papers");
    const { plannable, needsGoal } = readingCandidates(papers, (await ctx.frame()).today, 1);
    const pick = plannable[0];
    if (!pick) {
      const inbox = papers.filter((paper) => derivePaperStatus(paper) === "inbox").length;
      return `No paper is ready to plan: ${needsGoal.length ? `${needsGoal.length} need a reading goal before their Skim (update_paper goal)` : ""}${needsGoal.length && inbox ? "; " : ""}${inbox ? `${inbox} are still in the inbox (update_paper_status queue)` : ""}${!needsGoal.length && !inbox ? "nothing is queued or in progress" : ""}. Use objective readingHabit for an open sitting instead.`;
    }
    return { objectiveRef: { kind: "paper", id: pick.paper.id, passNo: pick.passNo }, type: "reading", defaultTitle: `${PASS_LABELS[pick.passNo]}: ${cleanPaperTitle(pick.paper)}` };
  }
  if (objective.kind === "revisionQueue") return { objectiveRef: { kind: "revisionQueue" }, type: "deep_work", defaultTitle: "Review revisions" };
  if (objective.kind === "paper") {
    const paper = await ctx.get<Paper>("papers", objective.paperId);
    if (!paper) return `No paper with id ${objective.paperId}.`;
    const status = derivePaperStatus(paper);
    if (status === "dropped" || status === "read") return `"${paper.title}" is ${status}; there's no pass left to plan.`;
    const passNo = objective.passNo ?? nextReadingPass(paper) ?? undefined;
    if (!passNo) return `"${paper.title}" has no next pass to read (it is ${status}).`;
    const pass = paper[`pass${passNo}` as const];
    if (pass?.status === "done" || pass?.status === "skipped") return `"${paper.title}"'s ${PASS_LABELS[passNo]} is already ${pass.status}.`;
    if (passNo > 1 && paper[`pass${(passNo - 1) as 1 | 2}` as const]?.status !== "done") return `"${paper.title}"'s ${PASS_LABELS[(passNo - 1) as 1 | 2]} isn't done yet, so its ${PASS_LABELS[passNo]} can't be planned.`;
    return { objectiveRef: { kind: "paper", id: paper.id, passNo }, type: "reading", defaultTitle: `${PASS_LABELS[passNo]}: ${cleanPaperTitle(paper)}` };
  }
  if (objective.kind === "checkpoint") {
    const checkpoint = (await ctx.sub<Checkpoint>("courses", objective.courseId, "checkpoints")).find((item) => item.id === objective.checkpointId);
    if (!checkpoint) return `No assessment ${objective.checkpointId} in course ${objective.courseId}.`;
    if (["done", "submitted", "missed"].includes(checkpoint.status)) return `"${checkpoint.title}" is ${checkpoint.status}; there's nothing left to prep.`;
    return { objectiveRef: { kind: "checkpoint", id: checkpoint.id }, type: "deep_work", defaultTitle: `Prep: ${checkpoint.title}`, courseId: objective.courseId };
  }
  const goal = await ctx.get<Goal>("goals", objective.goalId);
  if (!goal) return `No goal with id ${objective.goalId}.`;
  if (goal.status !== "active") return `"${goal.title}" is ${goal.status}; blocks can only be planned for an active goal.`;
  const milestone = objective.milestoneId ? goal.milestones.find((item) => item.id === objective.milestoneId) : undefined;
  if (objective.milestoneId && !milestone) return `"${goal.title}" has no milestone ${objective.milestoneId}.`;
  if (milestone?.done) return `"${milestone.title}" is already done.`;
  return { objectiveRef: { kind: "goal", id: goal.id, ...(milestone ? { milestoneId: milestone.id } : {}) }, type: "deep_work", defaultTitle: milestone ? `${goal.title}: ${milestone.title}` : goal.title };
}

/** Course, bucket and task references on a block, checked the way add_block always has. */
async function workRefusal(ctx: ToolContext, refs: { courseId?: string; bucket?: string; taskIds?: string[] }): Promise<string | null> {
  if (refs.bucket && !refs.courseId) return "A bucket only means something on course work: pass courseId too.";
  const courses = await ctx.list<Course>("courses");
  if (refs.courseId) {
    const course = courses.find((c) => c.id === refs.courseId);
    if (!course) return `No course with id ${refs.courseId}.`;
    const status = effectiveCourseStatus(course, (await ctx.frame()).today);
    if (status !== "active") return `"${course.name}" is ${status}; blocks can only be planned for an active course.`;
  }
  if (refs.taskIds?.length) {
    const tasks = await ctx.list<Task>("tasks");
    for (const id of refs.taskIds) {
      const task = tasks.find((t) => t.id === id);
      if (!task) return `No task with id ${id}.`;
      if (task.status === "done") return `"${task.title}" is already done.`;
      if (isFromDroppedCourse(task, courses)) return `"${task.title}" belongs to a dropped course.`;
    }
  }
  return null;
}

type BlockInput = { title?: string; type?: ScheduleSlot["type"]; startTime: string; endTime: string; taskIds?: string[]; courseId?: string; bucket?: ScheduleSlot["bucket"]; objective?: ObjectiveInput; note?: string };

/**
 * One new block from Claude's input, checked: it ends after it starts, isn't in the past, fits the
 * sitting bounds, and its references are live. `plannedMinutes` is its length: that is what the day
 * score and the resume timer measure it against.
 */
async function buildBlock(ctx: ToolContext, day: DayContext, input: BlockInput, base?: ScheduleSlot): Promise<ScheduleSlot | string> {
  if (minutesFromTime(input.endTime) <= minutesFromTime(input.startTime)) return `"${input.title ?? base?.title ?? "block"}" must end after it starts (blocks can't cross midnight).`;
  if (day.isClockDay && minutesFromTime(input.startTime) < day.minute) return `It's already past ${input.startTime} today; place "${input.title ?? base?.title ?? "the block"}" later.`;
  const resolved = input.objective ? await resolveObjective(ctx, input.objective) : null;
  if (typeof resolved === "string") return resolved;
  const type = input.type ?? base?.type ?? resolved?.type;
  if (!type) return "Give the block a type.";
  if (resolved?.type === "reading" && type !== "reading") return `A ${input.objective!.kind === "paper" ? "paper" : "reading"} sitting is a reading block (type "reading").`;
  const title = (input.title ?? base?.title ?? resolved?.defaultTitle)?.trim();
  if (!title) return "Give the block a title (or an objective to name it from).";
  const courseId = input.courseId ?? resolved?.courseId ?? base?.courseId;
  const refused = await workRefusal(ctx, { courseId: input.courseId ?? resolved?.courseId, bucket: input.bucket, taskIds: input.taskIds });
  if (refused) return refused;
  const tooLong = await boundsRefusal(ctx, { type, startTime: input.startTime, endTime: input.endTime, title });
  if (tooLong) return tooLong;
  const slot = createSlot({
    ...(base ?? {}),
    id: base?.id,
    title,
    type,
    startTime: input.startTime,
    endTime: input.endTime,
    assignedTaskIds: input.taskIds ?? base?.assignedTaskIds ?? [],
    courseId,
    bucket: input.bucket ?? base?.bucket,
    note: input.note ?? base?.note ?? "",
    objectiveRef: resolved?.objectiveRef ?? base?.objectiveRef,
    chunk: base?.chunk
  });
  // plannedMinutes feeds the day score and the resume timer: a block is planned at its own length.
  slot.plannedMinutes = slotDuration(slot);
  // A placed objective sitting is kept at its time when a replan in the app releases it ("Keep my moves").
  if (slot.objectiveRef) slot.placedByUser = true;
  return slot;
}

function slotSummary(slot: ScheduleSlot) {
  return `${slot.startTime}–${slot.endTime} ${slot.title}`;
}

export function registerScheduleTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "add_block",
    {
      title: "Add a block to a day",
      description:
        "Places one block on a date (today or later, never in the past). A sitting (deep_work, reading, admin) must fit the person's sitting bounds; for longer work use add_session. Give an objective to tie the block to a paper pass, the reading habit, the revision queue, an assessment or a goal: focus time in it then counts there (title and type can then be left out). The block may not overlap anything already there. A date never planned is saved with its classes, commitments and routine first; the result lists them. Classes, commitments and calendar events can't be added here.",
      inputSchema: z.object({ date: dateKey, ...blockFields, title: blockFields.title.optional(), type: placeable.optional(), calendar: calendarMode, idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, calendar, idempotencyKey: key, ...input }) =>
      scheduleWrite(ctx, "add_block", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const slot = await buildBlock(ctx, day, input);
        if (typeof slot === "string") return fail(slot);
        return {
          date,
          day,
          slots: [...day.slots, slot],
          result: { added: blockView(slot, viewFor(date, day)), date, builtDay: builtDayNote(day) },
          changes: [{ targetType: "block", targetId: `${date}/${slot.id}`, title: slot.title, before: null, after: { date, startTime: slot.startTime, endTime: slot.endTime, type: slot.type, objective: slot.objectiveRef ?? null } }]
        };
      })
  );

  server.registerTool(
    "update_block",
    {
      title: "Change what a block is for",
      description:
        "Changes a block's title, type, note, tasks, course/bucket or objective without moving it (pass objective: null to unlink it). Use it to link an existing reading block to a paper pass so its focus time counts toward that paper. Same refusals as move_block: never the locked or fixed layer, never a block that has started, finished or has focus time.",
      inputSchema: z.object({
        date: dateKey,
        slotId: z.string(),
        title: blockFields.title.optional(),
        type: placeable.optional(),
        taskIds: blockFields.taskIds,
        courseId: z.string().nullable().optional(),
        bucket: blockFields.bucket.nullable(),
        objective: objectiveInput.nullable().optional(),
        note: blockFields.note,
        tentative: z.boolean().optional().describe("false once a tentative time is confirmed."),
        attendees: z.array(z.string().max(100)).max(20).optional().describe("For a meeting."),
        agenda: z.array(z.string().max(300)).max(30).optional().describe("For a meeting: its agenda (see get_meeting_prep)."),
        actionItems: z.array(z.string().max(300)).max(30).optional().describe("For a meeting, afterwards: what was agreed. Also create tasks for them."),
        calendar: calendarMode,
        idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, slotId, calendar, idempotencyKey: key, objective, courseId, bucket, tentative, attendees, agenda, actionItems, ...input }) =>
      scheduleWrite(ctx, "update_block", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const slot = day.slots.find((s) => s.id === slotId);
        if (!slot) return fail(`No block ${slotId} on ${date}.`);
        const refused = editableRefusal(slot, day);
        if (refused) return fail(refused);
        const base: ScheduleSlot = {
          ...slot,
          ...(objective === null ? { objectiveRef: undefined, placedByUser: undefined } : {}),
          ...(courseId === null ? { courseId: undefined, bucket: undefined } : {}),
          ...(bucket === null ? { bucket: undefined } : {})
        };
        const updated = await buildBlock(ctx, day, { ...input, startTime: slot.startTime, endTime: slot.endTime, objective: objective ?? undefined, courseId: courseId ?? undefined, bucket: bucket ?? undefined }, base);
        if (typeof updated === "string") return fail(updated);
        // Only what was asked changes: the block keeps its time and its planned minutes.
        updated.plannedMinutes = slot.plannedMinutes;
        updated.tentative = tentative === undefined ? slot.tentative : tentative || undefined;
        if (attendees || agenda || actionItems) updated.meeting = { ...slot.meeting, ...(attendees ? { attendees } : {}), ...(agenda ? { agenda } : {}), ...(actionItems ? { actionItems } : {}) };
        if (!objective && objective !== null) updated.placedByUser = slot.placedByUser;
        const keys = ["title", "type", "note", "assignedTaskIds", "courseId", "bucket", "objectiveRef", "tentative", "meeting"];
        return {
          date,
          day,
          slots: day.slots.map((s) => (s.id === slotId ? updated : s)),
          result: { updated: blockView(updated, viewFor(date, day)) },
          changes: [{ targetType: "block", targetId: `${date}/${slotId}`, title: updated.title, ...diff(slot, updated, keys) }]
        };
      })
  );

  server.registerTool(
    "move_block",
    {
      title: "Move or resize a block",
      description:
        "Changes a block's start and end time on the same date. Address it by date and slotId (from get_day). A resized sitting is planned at its new length. Refused for classes, routine, calendar events and commitments, for blocks that have started, finished or have focus time on them, for times already past, and for sittings outside the sitting bounds. To move several blocks at once use shift_blocks or apply_plan.",
      inputSchema: z.object({ date: dateKey, slotId: z.string(), startTime: clock, endTime: clock, tentative: z.boolean().optional().describe("false confirms a tentative block at the new time."), calendar: calendarMode, idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, slotId, startTime, endTime, tentative, calendar, idempotencyKey: key }) =>
      scheduleWrite(ctx, "move_block", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const slot = day.slots.find((s) => s.id === slotId);
        if (!slot) return fail(`No block ${slotId} on ${date}.`);
        const refused = editableRefusal(slot, day);
        if (refused) return fail(refused);
        if (minutesFromTime(endTime) <= minutesFromTime(startTime)) return fail("A block must end after it starts (blocks can't cross midnight).");
        if (day.isClockDay && minutesFromTime(startTime) < day.minute) return fail(`It's already past ${startTime} today.`);
        const moved: ScheduleSlot = { ...slot, startTime, endTime, ...(tentative !== undefined ? { tentative: tentative || undefined } : {}) };
        if (tentative === false && slot.tentative) {
          // Confirmed: the "time TBC" note and the part-of-day guess no longer apply.
          moved.note = (slot.note ?? "").replace(/Time TBC \([^)]*\)( · )?/, "").trim();
          if (slot.meeting?.window) moved.meeting = { ...slot.meeting, window: undefined };
        }
        // A resized sitting is planned at its new length, so the day score measures it against what fits.
        if (slotDuration(moved) !== slotDuration(slot)) moved.plannedMinutes = slotDuration(moved);
        const tooLong = await boundsRefusal(ctx, moved);
        if (tooLong) return fail(tooLong);
        return {
          date,
          day,
          slots: day.slots.map((s) => (s.id === slotId ? moved : s)),
          result: { moved: blockView(moved, viewFor(date, day)), from: `${slot.startTime}–${slot.endTime}` },
          changes: [{ targetType: "block", targetId: `${date}/${slotId}`, title: slot.title, ...diff(slot, moved, ["startTime", "endTime", "plannedMinutes", "tentative"]) }]
        };
      })
  );

  server.registerTool(
    "remove_block",
    {
      title: "Remove a block",
      description: "Takes one block off a date, addressed by date and slotId. Same refusals as move_block: never the locked or fixed layer, never a block that has started, finished or has focus time.",
      inputSchema: z.object({ date: dateKey, slotId: z.string(), calendar: calendarMode, idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, slotId, calendar, idempotencyKey: key }) =>
      scheduleWrite(ctx, "remove_block", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const slot = day.schedule?.slots.find((s) => s.id === slotId);
        if (!slot) return fail(day.slots.some((s) => s.id === slotId) ? "That block is part of the fixed layer of the day and can't be removed." : `No block ${slotId} on ${date}.`);
        const refused = editableRefusal(slot, day);
        if (refused) return fail(refused);
        const remaining = day.slots.filter((s) => s.id !== slotId);
        return {
          date,
          day,
          slots: remaining,
          result: { removed: { title: slot.title, startTime: slot.startTime, endTime: slot.endTime }, date, dayNow: blocksView(remaining, viewFor(date, day)).map((b) => ({ slotId: b.slotId, title: b.title, startTime: b.startTime, endTime: b.endTime })) },
          changes: [{ targetType: "block", targetId: `${date}/${slotId}`, title: slot.title, before: { date, startTime: slot.startTime, endTime: slot.endTime, type: slot.type }, after: null }]
        };
      })
  );

  server.registerTool(
    "apply_plan",
    {
      title: "Set a day's plan in one call",
      description:
        "Replaces the editable layer of one day with the blocks given, atomically: either the whole plan is saved or nothing is. Blocks with a slotId update that existing block (keeping its sitting numbering); blocks without one are added; editable blocks not listed are removed. The locked and fixed layers (classes, routine, calendar events, commitments) and every block that has started, finished or has focus time are always kept and can't be listed. Each block follows add_block's rules, and the day is validated as a whole, so moves never collide with a block's old position. Use calendar: \"dryRun\" to preview.",
      inputSchema: z.object({
        date: dateKey,
        blocks: z.array(z.object({ slotId: z.string().optional().describe("An existing editable block to keep or change."), ...blockFields, title: blockFields.title.optional(), type: placeable.optional() })).max(40),
        calendar: calendarMode,
        idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, blocks, calendar, idempotencyKey: key }) =>
      scheduleWrite(ctx, "apply_plan", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const kept = day.slots.filter((slot) => editableRefusal(slot, day) !== null);
        const editable = day.slots.filter((slot) => editableRefusal(slot, day) === null);
        const byId = new Map(editable.map((slot) => [slot.id, slot]));
        const seen = new Set<string>();
        const next: ScheduleSlot[] = [];
        const changes: ActivityChange[] = [];
        const added: string[] = [];
        const changed: string[] = [];
        for (const [index, input] of blocks.entries()) {
          if (input.slotId) {
            const existing = byId.get(input.slotId);
            if (!existing) {
              const fixed = kept.find((slot) => slot.id === input.slotId);
              return fail(`Block ${index + 1}: ${fixed ? editableRefusal(fixed, day) : `no editable block ${input.slotId} on ${date}.`} Leave it out; it is kept as it is.`);
            }
            if (seen.has(input.slotId)) return fail(`Block ${index + 1}: ${input.slotId} is listed twice.`);
            seen.add(input.slotId);
            const built = await buildBlock(ctx, day, input, existing);
            if (typeof built === "string") return fail(`Block ${index + 1} ("${input.title ?? existing.title}"): ${built}`);
            if (slotDuration(built) === slotDuration(existing) && !input.objective) built.plannedMinutes = existing.plannedMinutes;
            if (!input.objective) built.placedByUser = existing.placedByUser;
            next.push(built);
            const keys = ["title", "type", "startTime", "endTime", "note", "assignedTaskIds", "courseId", "bucket", "objectiveRef"];
            const delta = diff(existing, built, keys);
            if (JSON.stringify(delta.before) !== JSON.stringify(delta.after)) {
              changed.push(`${slotSummary(built)} (was ${existing.startTime}–${existing.endTime})`);
              changes.push({ targetType: "block", targetId: `${date}/${built.id}`, title: built.title, ...delta });
            }
          } else {
            const built = await buildBlock(ctx, day, input);
            if (typeof built === "string") return fail(`Block ${index + 1} ("${input.title ?? "new"}"): ${built}`);
            next.push(built);
            added.push(slotSummary(built));
            changes.push({ targetType: "block", targetId: `${date}/${built.id}`, title: built.title, before: null, after: { date, startTime: built.startTime, endTime: built.endTime, type: built.type } });
          }
        }
        const removed = editable.filter((slot) => !seen.has(slot.id));
        for (const slot of removed) changes.push({ targetType: "block", targetId: `${date}/${slot.id}`, title: slot.title, before: { date, startTime: slot.startTime, endTime: slot.endTime, type: slot.type }, after: null });
        const slots = [...kept, ...next];
        return {
          date,
          day,
          slots,
          result: compact({
            date,
            added,
            changed,
            removed: removed.map(slotSummary),
            keptAsIs: kept.length,
            builtDay: builtDayNote(day),
            dayNow: blocksView(slots, viewFor(date, day)).map((b) => compact({ slotId: b.slotId, title: b.title, startTime: b.startTime, endTime: b.endTime, layer: b.layer }))
          }),
          changes
        };
      })
  );

  server.registerTool(
    "shift_blocks",
    {
      title: "Move a range of blocks together",
      description:
        "Moves every editable block that starts at or after `from` and before `to` on one date by `offsetMinutes` (negative = earlier), keeping their lengths and order. Classes, routine, calendar events, commitments and anything started or worked stay put. Refused as a whole if a moved block would land on one of them, run past midnight or start in the past: then shift a smaller range or use apply_plan.",
      inputSchema: z.object({ date: dateKey, from: clock, to: clock.optional().describe("Default: the end of the day."), offsetMinutes: z.number().int().min(-1439).max(1439), calendar: calendarMode, idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, from, to, offsetMinutes, calendar, idempotencyKey: key }) =>
      scheduleWrite(ctx, "shift_blocks", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        if (offsetMinutes === 0) return fail("offsetMinutes is 0; nothing would move.");
        const start = minutesFromTime(from);
        const end = to ? minutesFromTime(to) : 24 * 60;
        const moving = day.slots.filter((slot) => minutesFromTime(slot.startTime) >= start && minutesFromTime(slot.startTime) < end && editableRefusal(slot, day) === null);
        if (moving.length === 0) return fail(`No editable blocks start between ${from} and ${to ?? "the end of the day"} on ${date}.`);
        const ids = new Set(moving.map((slot) => slot.id));
        const shifted = moving.map((slot) => {
          const s0 = minutesFromTime(slot.startTime) + offsetMinutes;
          const e0 = minutesFromTime(slot.endTime) + offsetMinutes;
          return { slot, s0, e0 };
        });
        const outside = shifted.find(({ s0, e0 }) => s0 < 0 || e0 > 24 * 60);
        if (outside) return fail(`"${outside.slot.title}" would run ${outside.s0 < 0 ? "before midnight" : "past midnight"}.`);
        const past = shifted.find(({ s0 }) => day.isClockDay && s0 < day.minute);
        if (past) return fail(`"${past.slot.title}" would start at ${minutesToTime(past.s0)}, which has already passed today.`);
        const moved = shifted.map(({ slot, s0, e0 }) => ({ ...slot, startTime: minutesToTime(s0), endTime: minutesToTime(e0) }));
        const slots = [...day.slots.filter((slot) => !ids.has(slot.id)), ...moved];
        return {
          date,
          day,
          slots,
          result: { date, moved: moved.map((slot) => `${slot.title}: ${shifted.find((x) => x.slot.id === slot.id)!.slot.startTime} → ${slot.startTime}`), stayedPut: day.slots.filter((slot) => !ids.has(slot.id) && minutesFromTime(slot.startTime) >= start && minutesFromTime(slot.startTime) < end).map(slotSummary) },
          changes: moved.map((slot) => {
            const before = day.slots.find((s) => s.id === slot.id)!;
            return { targetType: "block", targetId: `${date}/${slot.id}`, title: slot.title, ...diff(before, slot, ["startTime", "endTime"]) };
          })
        };
      })
  );

  server.registerTool(
    "add_session",
    {
      title: "Plan a long session as sittings",
      description:
        "Splits totalMinutes of work into sittings within the person's sitting bounds and lays them out from `start` with a break between each, stepping past anything already on the day. Each sitting is titled \"<title> (i of n)\" and numbered as one split, like the weekly planner's. Refused if it can't all fit before midnight. Give an objective (e.g. a paper pass) to make every sitting count toward it.",
      inputSchema: z.object({
        date: dateKey,
        start: clock,
        totalMinutes: z.number().int().min(1).max(720),
        title: blockFields.title.optional(),
        type: placeable.optional(),
        breakMinutes: z.number().int().min(0).max(60).optional().describe("Gap between sittings. Default: the person's short break, else 10."),
        objective: objectiveInput.optional(),
        taskIds: blockFields.taskIds,
        courseId: blockFields.courseId,
        bucket: blockFields.bucket,
        note: blockFields.note,
        calendar: calendarMode,
        idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, start, totalMinutes, breakMinutes, calendar, idempotencyKey: key, ...input }) =>
      scheduleWrite(ctx, "add_session", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        const settings = await ctx.settings();
        const bounds = sittingBounds(settings);
        const gap = breakMinutes ?? settings.shortBreakMinutes ?? 10;
        const lengths = splitIntoChunks(totalMinutes, bounds);
        const first = await buildBlock(ctx, day, { ...input, startTime: start, endTime: minutesToTime(Math.min(minutesFromTime(start) + lengths[0], 24 * 60 - 1)) });
        if (typeof first === "string") return fail(first);
        const base = first.title;
        const groupId = crypto.randomUUID();
        const placed: ScheduleSlot[] = [];
        let cursor = minutesFromTime(start);
        for (const [index, length] of lengths.entries()) {
          // Step past anything already there (or already placed) that the sitting would overlap.
          for (let guard = 0; guard < 100; guard += 1) {
            const hit = [...day.slots, ...placed].find((slot) => !slot.tentative && cursor < minutesFromTime(slot.endTime) && minutesFromTime(slot.startTime) < cursor + length);
            if (!hit) break;
            cursor = minutesFromTime(hit.endTime);
          }
          if (cursor + length > 24 * 60) return fail(`Only ${index} of ${lengths.length} sittings fit on ${date} after ${start}. Start earlier, shorten the session, or spread it over two days.`);
          const sitting: ScheduleSlot = {
            ...first,
            id: crypto.randomUUID(),
            title: sittingTitle(base, index + 1, lengths.length),
            startTime: minutesToTime(cursor),
            endTime: minutesToTime(cursor + length),
            plannedMinutes: length,
            ...(lengths.length > 1 ? { chunk: { groupId, index: index + 1, total: lengths.length } } : {})
          };
          placed.push(sitting);
          cursor += length + gap;
        }
        return {
          date,
          day,
          slots: [...day.slots, ...placed],
          result: compact({ date, sittings: placed.map(slotSummary), totalMinutes, sittingBounds: bounds, builtDay: builtDayNote(day) }),
          changes: placed.map((slot) => ({ targetType: "block", targetId: `${date}/${slot.id}`, title: slot.title, before: null, after: { date, startTime: slot.startTime, endTime: slot.endTime, type: slot.type } }))
        };
      })
  );

  server.registerTool(
    "add_meeting",
    {
      title: "Add a meeting",
      description:
        "Adds a one-off meeting block (type meeting: not a scored sitting). With startTime/endTime it sits at that time. With only window (morning, afternoon or evening), for a meeting whose time isn't confirmed (\"probably afternoon, TBC\"), it is held as a tentative block across that part of the day: tentative blocks are soft, so other blocks may still go there and planning still uses the time. Confirm later with move_block(startTime, endTime, tentative: false). Pass tentative: true with a time to hold a guessed slot softly.",
      inputSchema: z.object({
        date: dateKey,
        title: z.string().min(1).max(200),
        attendees: z.array(z.string().max(100)).max(20).optional(),
        startTime: clock.optional(),
        endTime: clock.optional(),
        window: z.enum(["morning", "afternoon", "evening"]).optional(),
        durationMinutes: z.number().int().min(5).max(480).optional().describe("Expected length, noted on a tentative block."),
        tentative: z.boolean().optional(),
        agenda: z.array(z.string().max(300)).max(20).optional(),
        note: z.string().max(500).optional(),
        calendar: calendarMode,
        idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ date, title, attendees, startTime, endTime, window, durationMinutes, tentative, agenda, note, calendar, idempotencyKey: key }) =>
      scheduleWrite(ctx, "add_meeting", key, calendar, async () => {
        const day = await openDay(ctx, date);
        if (typeof day === "string") return fail(day);
        if (Boolean(startTime) !== Boolean(endTime)) return fail("Give both startTime and endTime, or a window instead.");
        if (!startTime && !window) return fail("Give a time (startTime and endTime) or a window (morning, afternoon, evening).");
        // A window is held inside the person's working hours, so "morning" doesn't start at midnight.
        const working = (await ctx.settings()).workingWindow ?? DEFAULT_WORKING_WINDOW;
        const part = window ? TIME_OF_DAY_WINDOWS[window] : null;
        const clipped = part ? { start: Math.max(part.start, minutesFromTime(working.startTime)), end: Math.min(part.end, minutesFromTime(working.endTime)) } : null;
        const range = startTime ? { start: minutesFromTime(startTime), end: minutesFromTime(endTime!) } : clipped && clipped.end > clipped.start ? clipped : part!;
        if (range.end <= range.start) return fail("A meeting must end after it starts.");
        if (day.isClockDay && range.end <= day.minute) return fail("That time has already passed today.");
        const soft = tentative ?? !startTime;
        const expected = durationMinutes ? `about ${durationMinutes} min` : "";
        const slot = createSlot({
          title: title.trim(),
          type: "meeting",
          startTime: minutesToTime(Math.max(range.start, day.isClockDay ? Math.ceil(day.minute / 15) * 15 : range.start)),
          endTime: minutesToTime(range.end),
          note: [note, soft && !startTime ? `Time TBC (${window}${expected ? `, ${expected}` : ""})` : expected].filter(Boolean).join(" · "),
          tentative: soft || undefined,
          meeting: compact({ attendees, window, agenda }) as ScheduleSlot["meeting"]
        });
        return {
          date,
          day,
          slots: [...day.slots, slot],
          result: compact({ added: blockView(slot, viewFor(date, day)), tentative: soft ? "Held softly: other blocks can go here, and planning still uses the time." : undefined, builtDay: builtDayNote(day) }),
          changes: [{ targetType: "block", targetId: `${date}/${slot.id}`, title: slot.title, before: null, after: { date, startTime: slot.startTime, endTime: slot.endTime, type: slot.type, tentative: slot.tentative ?? false } }]
        };
      })
  );

  server.registerTool(
    "plan_lead_up",
    {
      title: "Plan the lead-up to a deadline or meeting",
      description:
        "\"Finish these things by Monday 12:00 for my supervisor meeting\": lays the sittings out backwards from the deadline. Each item's minutes get extraPercent on top (default 20%), are split into sittings within the sitting bounds, and are placed as late as fits before the deadline, earlier items before later ones, with an optional buffer sitting last. Uses the day shape (deep work only in deep windows) or the working window, skips days off, never passes maxSittingsPerDay (default: the person's cap, else 7) on a day, and steps past everything already planned. Writes nothing unless every sitting fits; call with calendar: \"dryRun\" first to show the layout.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe("What it's for, e.g. \"Supervisor meeting\"."),
        deadlineDate: dateKey,
        deadlineTime: clock.optional().describe("Everything ends by this time on deadlineDate. Default: the end of that day's work windows."),
        items: z
          .array(
            z.object({
              title: blockFields.title.optional(),
              minutes: z.number().int().min(10).max(1200),
              type: placeable.optional(),
              objective: objectiveInput.optional(),
              taskIds: blockFields.taskIds,
              courseId: blockFields.courseId,
              bucket: blockFields.bucket
            })
          )
          .min(1)
          .max(10),
        extraPercent: z.number().int().min(0).max(100).optional(),
        bufferSession: z.boolean().optional().describe("Default true: one extra sitting last, before the deadline."),
        bufferMinutes: z.number().int().min(10).max(120).optional(),
        startDate: dateKey.optional().describe("Earliest day to use. Default today."),
        includeNonWorkingDays: z.boolean().optional().describe("Default false: only the working window's days."),
        maxSittingsPerDay: z.number().int().min(1).max(15).optional(),
        calendar: calendarMode,
        idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ title, deadlineDate, deadlineTime, items, extraPercent, bufferSession, bufferMinutes, startDate, includeNonWorkingDays, maxSittingsPerDay, calendar, idempotencyKey: key }) => {
      const build = async (): Promise<{ edits: DayEdit[]; summary: Record<string, unknown> } | CallToolResult> => {
        const frame = await ctx.frame();
        const settings = await ctx.settings();
        const bounds = sittingBounds(settings);
        const first = startDate && startDate > frame.scheduleDay ? startDate : frame.scheduleDay;
        if (deadlineDate < first) return fail(`${deadlineDate} is before ${first}; there's no time left to plan into.`);
        const working = settings.workingWindow ?? DEFAULT_WORKING_WINDOW;
        const shape = dayShapeWindows(settings.dayShape);
        const baseWindows = shape ?? [{ start: minutesFromTime(working.startTime), end: minutesFromTime(working.endTime), energy: undefined }];
        const days: (LeadUpDay & { day: DayContext })[] = [];
        const skipped: string[] = [];
        for (let date = first; date <= deadlineDate; date = addDaysToKey(date, 1)) {
          if (!includeNonWorkingDays && !working.daysOfWeek.includes(getDay(parseISO(date)))) continue;
          const dayDoc = await ctx.get<Day>("days", date);
          if (dayDoc?.dayOff) {
            skipped.push(`${date} (day off)`);
            continue;
          }
          const day = await openDay(ctx, date);
          if (typeof day === "string") {
            skipped.push(`${date} (${day})`);
            continue;
          }
          const floor = day.isClockDay ? Math.ceil(day.minute / 15) * 15 : 0;
          const ceilingMinute = date === deadlineDate && deadlineTime ? minutesFromTime(deadlineTime) : 24 * 60;
          const windows = baseWindows
            .map((w) => ({ start: Math.max(w.start, floor), end: Math.min(w.end, ceilingMinute), energy: w.energy }))
            .filter((w) => w.end > w.start);
          if (windows.length === 0) continue;
          days.push({
            dateKey: date,
            windows,
            busy: day.slots.filter((slot) => !slot.tentative).map((slot) => ({ start: minutesFromTime(slot.startTime), end: minutesFromTime(slot.endTime) })),
            sittings: day.slots.filter(isScoredSitting).length,
            day
          });
        }
        if (days.length === 0) return fail(`No usable work time between ${first} and ${deadlineDate}${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}.`);

        // Each item becomes a template block (validated once, like add_session) and its sittings.
        const extra = (extraPercent ?? 20) / 100;
        const templates: { slot: ScheduleSlot; lengths: number[]; groupId: string }[] = [];
        const probeDay = days[days.length - 1].day;
        for (const [index, item] of items.entries()) {
          const total = Math.round((item.minutes * (1 + extra)) / 5) * 5;
          const split = splitIntoChunks(total, bounds);
          // A small item still gets a whole sitting: shorter than the shortest sitting, it couldn't be placed.
          const lengths = split.length === 1 && split[0] < bounds.minChunkMinutes ? [bounds.minChunkMinutes] : split;
          const template = await buildBlock(ctx, { ...probeDay, isClockDay: false }, { ...item, type: item.type ?? (item.objective ? undefined : "deep_work"), startTime: "00:00", endTime: minutesToTime(lengths[0]) });
          if (typeof template === "string") return fail(`Item ${index + 1}: ${template}`);
          templates.push({ slot: template, lengths, groupId: crypto.randomUUID() });
        }
        if (bufferSession ?? true) {
          const minutes = Math.min(bufferMinutes ?? Math.min(45, bounds.maxChunkMinutes), bounds.maxChunkMinutes);
          const buffer = createSlot({ title: `Buffer: ${title.trim()}`, type: "deep_work", startTime: "00:00", endTime: minutesToTime(minutes), note: `Slack before ${title.trim()}: finish whatever ran over.` });
          templates.push({ slot: buffer, lengths: [minutes], groupId: crypto.randomUUID() });
        }
        const sittings = templates.flatMap((t, ti) => t.lengths.map((minutes, si) => ({ key: `${ti}:${si}`, minutes, energy: energyOf(t.slot) })));
        const layout = layOutBackwards({ sittings, days, maxSittings: maxSittingsPerDay ?? settings.maxSittingsPerDay ?? DEFAULT_MAX_SITTINGS_PER_DAY, gapMinutes: settings.shortBreakMinutes ?? 10 });
        const name = (k: string) => {
          const [ti, si] = k.split(":").map(Number);
          return sittingTitle(templates[ti].slot.title, si + 1, templates[ti].lengths.length);
        };
        if (layout.unplaced.length > 0) {
          return fail(
            `Not everything fits before ${deadlineDate}${deadlineTime ? ` ${deadlineTime}` : ""}: ${layout.unplaced.map(name).join(", ")} had no room (sitting cap ${maxSittingsPerDay ?? settings.maxSittingsPerDay ?? DEFAULT_MAX_SITTINGS_PER_DAY}/day${shape ? ", deep work only in deep windows" : ""}). Start earlier (startDate), allow weekends (includeNonWorkingDays), lower extraPercent, drop the buffer, or raise maxSittingsPerDay.`
          );
        }
        const byDate = new Map<string, ScheduleSlot[]>();
        for (const placement of layout.placed) {
          const [ti, si] = placement.key.split(":").map(Number);
          const t = templates[ti];
          const slot: ScheduleSlot = {
            ...t.slot,
            id: crypto.randomUUID(),
            title: sittingTitle(t.slot.title, si + 1, t.lengths.length),
            startTime: minutesToTime(placement.start),
            endTime: minutesToTime(placement.end),
            plannedMinutes: placement.end - placement.start,
            ...(t.lengths.length > 1 ? { chunk: { groupId: t.groupId, index: si + 1, total: t.lengths.length } } : {})
          };
          byDate.set(placement.dateKey, [...(byDate.get(placement.dateKey) ?? []), slot]);
        }
        const edits: DayEdit[] = [...byDate.entries()].map(([date, added]) => {
          const day = days.find((d) => d.dateKey === date)!.day;
          return {
            date,
            day,
            slots: [...day.slots, ...added],
            result: { date, added: sortedSlots(added).map(slotSummary), sittingsThatDay: day.slots.filter(isScoredSitting).length + added.length },
            changes: added.map((slot) => ({ targetType: "block", targetId: `${date}/${slot.id}`, title: slot.title, before: null, after: { date, startTime: slot.startTime, endTime: slot.endTime, type: slot.type } }))
          };
        });
        for (const edit of edits) {
          const errors = validateSlots(edit.slots);
          if (errors.length > 0) return fail(`${edit.date}: ${errors.join(" ")}`);
        }
        const totalMinutes = layout.placed.reduce((sum, p) => sum + p.end - p.start, 0);
        return {
          edits: edits.sort((a, b) => a.date.localeCompare(b.date)),
          summary: compact({
            for: title,
            deadline: `${deadlineDate}${deadlineTime ? ` ${deadlineTime}` : ""}`,
            sittings: layout.placed.length,
            totalMinutes,
            extraPercent: extraPercent ?? 20,
            days: edits.map((edit) => edit.result),
            skippedDays: skipped
          })
        };
      };
      if (calendar === "dryRun") {
        const plan = await build();
        if ("content" in plan) return plan;
        return ok({ dryRun: "Nothing was saved. Call again without dryRun to place these sittings.", ...plan.summary });
      }
      return runWrite(ctx, "plan_lead_up", key, async () => {
        const plan = await build();
        if ("content" in plan) return plan;
        for (const edit of plan.edits) {
          await saveDailySchedule(ctx.uid, { dateKey: edit.date, templateId: edit.day.schedule?.templateId, slots: sortedSlots(edit.slots) });
          ctx.meter.writes += 1;
        }
        const pushed = await pushCalendar(ctx.uid, { mode: calendar });
        return { result: { ...plan.summary, calendar: pushed }, changes: plan.edits.flatMap((edit) => edit.changes) };
      });
    }
  );

  server.registerTool(
    "set_day_shape",
    {
      title: "Set the shape of a working day",
      description:
        "Sets when deep work happens and when only light work does, e.g. deep 05:30–13:00, light 13:45–18:00, nothing after. The weekly planner then puts deep work (deep_work, reading) only in deep windows and light work (admin, revision) in light windows first; Up next suggests no work outside the windows; block writes warn when deep work lands in a light window. Pass shape: null to clear it (work anywhere in the working window again).",
      inputSchema: z.object({
        shape: z
          .object({ deep: z.array(z.object({ startTime: clock, endTime: clock })).max(4), light: z.array(z.object({ startTime: clock, endTime: clock })).max(4) })
          .nullable(),
        idempotencyKey
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      scopeChallenge: needsWrite
    },
    async ({ shape, idempotencyKey: key }) =>
      runWrite(ctx, "set_day_shape", key, async () => {
        if (shape) {
          const windows = [...shape.deep, ...shape.light].map((w) => ({ ...w, s: minutesFromTime(w.startTime), e: minutesFromTime(w.endTime) }));
          const bad = windows.find((w) => w.e <= w.s);
          if (bad) return fail(`${bad.startTime}–${bad.endTime} must end after it starts.`);
          const sorted = [...windows].sort((a, b) => a.s - b.s);
          const overlap = sorted.find((w, i) => i > 0 && w.s < sorted[i - 1].e);
          if (overlap) return fail(`${overlap.startTime}–${overlap.endTime} overlaps another window.`);
          if (shape.deep.length === 0 && shape.light.length === 0) return fail("Give at least one window, or pass null to clear the shape.");
        }
        const before = (await ctx.settings()).dayShape ?? null;
        await userCol(ctx.uid, "meta").doc("settings").set({ dayShape: shape ?? FieldValue.delete(), updatedAt: new Date().toISOString() }, { merge: true });
        ctx.meter.writes += 1;
        return {
          result: { dayShape: shape ?? "cleared: work goes anywhere in the working window", note: "Applies to weekly planning from now on and to Up next immediately. Blocks already placed aren't moved." },
          changes: [{ targetType: "settings", targetId: "dayShape", title: "Day shape", before: { dayShape: before }, after: { dayShape: shape } }]
        };
      })
  );
}
