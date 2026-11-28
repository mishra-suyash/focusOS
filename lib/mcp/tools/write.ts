/**
 * plan/19 §5.2 Phase 3 — the additive writes. Each one goes through the same rules the app's own
 * screens apply for that action (not raw Firestore), and through `runWrite` (scope, idempotency,
 * activity log, usage). No deletes (D3): finishing, dropping and archiving are all undoable.
 */
import { requireScopes, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as writes from "@/lib/admin-writes";
import { userCol } from "@/lib/admin-writes";
import { CHECKPOINT_TYPE_DEFAULTS } from "@/lib/checkpoints";
import { splitTopics, topicRevisionSeed } from "@/lib/classlog-plan";
import { effectiveCourseStatus } from "@/lib/courses";
import { addDaysToKey } from "@/lib/dates";
import { diff, patchKeys, releaseFinishedWork, runWrite, type ActivityChange } from "@/lib/mcp/activity";
import { compact, fail, requireModule, type ToolContext } from "@/lib/mcp/context";
import { paperView, taskView } from "@/lib/mcp/views";
import { inboxPaper } from "@/lib/paper-capture";
import { DEFAULT_SHELF_DAYS, derivePaperStatus, dropPatch, queuePatch, restorePatch, shelvePatch, unqueuePatch } from "@/lib/papers";
import { computeStatusPatch } from "@/lib/tasks";
import { sittingBounds } from "@/lib/timeline";
import type { Checkpoint, ClassLog, Course, Day, Goal, GoalMilestone, NewTask, Paper, Task, Topic } from "@/types";

/** Additive: changes something, never deletes. claude.ai asks before running these unless allowed. */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** A token without `write` gets an HTTP 403 `insufficient_scope` challenge, so Claude can step up. */
const needsWrite = requireScopes("read", "write");

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-MM-dd");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm");
const idempotencyKey = z.string().max(200).optional().describe("Optional. Repeating a call with the same key returns the first result instead of writing twice.");
const priority = z.enum(["low", "medium", "high"]);
const category = z.enum(["research", "coding", "reading", "writing", "admin", "personal"]);
const bucket = z.enum(["goal", "assignment", "backlog", "revision"]);
const fixedTime = z.object({ startTime: clock, endTime: clock, location: z.string().max(200).optional() });

/** A course new work may point at: it exists, the Courses module is on, and it is active today (a dropped or finished course's work is never proposed). */
async function activeCourse(ctx: ToolContext, courseId: string): Promise<Course | string> {
  if (!(await ctx.modules()).has("courses")) return "The Courses module is turned off, so work can't be linked to a course.";
  const course = await ctx.get<Course>("courses", courseId);
  if (!course) return `No course with id ${courseId}.`;
  const status = effectiveCourseStatus(course, (await ctx.frame()).today);
  return status === "active" ? course : `"${course.name}" is ${status}; new work can only be linked to an active course.`;
}

/** Splits an input object into what to set and which optional fields to clear (passed as null). */
function setsAndClears<T extends Record<string, unknown>>(input: T, clearable: string[]) {
  const set: Record<string, unknown> = {};
  const cleared: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null) {
      if (clearable.includes(key)) cleared.push(key);
      continue;
    }
    set[key] = value;
  }
  return { set, cleared };
}

function minutesOf(time: string) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function registerWriteTools(server: McpServer, ctx: ToolContext) {
  // ---- tasks ----
  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description:
        "Adds a task. courseId must be an active course; bucket needs a courseId. maxChunkMinutes is kept inside the person's sitting bounds. A fixedTime task is never split. kind \"external\" is a hard deadline outside Workload (forms, visas, fees).",
      inputSchema: z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(5000).optional(),
        priority: priority.optional(),
        category: category.optional(),
        dueDate: dateKey.optional(),
        estimatedSessions: z.number().int().min(1).max(100).optional().describe("Focus sessions it needs (estimatedPomodoros)."),
        courseId: z.string().optional(),
        bucket: bucket.optional(),
        kind: z.enum(["internal", "external"]).optional(),
        reminderLeadDays: z.array(z.number().int().min(0).max(365)).max(10).optional(),
        weeklyTargetDay: z.number().int().min(0).max(6).optional().describe("0 = Sunday … 6 = Saturday."),
        maxChunkMinutes: z.number().int().min(5).max(480).optional(),
        splittable: z.boolean().optional(),
        fixedTime: fixedTime.optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async (input) =>
      runWrite(ctx, "create_task", input.idempotencyKey, async () => {
        if (input.bucket && !input.courseId) return fail("A bucket only means something on a course task: pass courseId too.");
        if (input.courseId) {
          const course = await activeCourse(ctx, input.courseId);
          if (typeof course === "string") return fail(course);
        }
        if (input.fixedTime && minutesOf(input.fixedTime.endTime) <= minutesOf(input.fixedTime.startTime)) return fail("fixedTime must end after it starts.");
        const bounds = sittingBounds(await ctx.settings());
        const chunk = input.maxChunkMinutes === undefined ? undefined : Math.min(bounds.maxChunkMinutes, Math.max(bounds.minChunkMinutes, input.maxChunkMinutes));
        const task: NewTask = {
          title: input.title.trim(),
          description: input.description,
          status: "todo",
          priority: input.priority ?? "medium",
          category: input.category ?? "research",
          dueDate: input.dueDate,
          estimatedPomodoros: input.estimatedSessions,
          courseId: input.courseId,
          bucket: input.bucket,
          kind: input.kind,
          reminderLeadDays: input.reminderLeadDays,
          weeklyTargetDay: input.weeklyTargetDay,
          maxChunkMinutes: chunk,
          splittable: input.fixedTime ? false : input.splittable,
          fixedTime: input.fixedTime
        };
        const id = await writes.createTask(ctx.uid, task);
        const created = (await ctx.get<Task>("tasks", id))!;
        return {
          result: compact({ created: taskView(created, { full: true }), note: chunk !== input.maxChunkMinutes ? `maxChunkMinutes was kept inside the sitting bounds (${bounds.minChunkMinutes}–${bounds.maxChunkMinutes}).` : undefined }),
          changes: [{ targetType: "task", targetId: id, title: created.title, before: null, after: taskView(created, { full: true }) }]
        };
      })
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a task",
      description:
        "Changes a task's fields. Pass null to clear an optional field. status here is only todo or in_progress; use complete_task and reopen_task to finish or reopen. Clearing courseId also clears bucket.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(5000).nullable().optional(),
        status: z.enum(["todo", "in_progress"]).optional(),
        priority: priority.optional(),
        category: category.optional(),
        dueDate: dateKey.nullable().optional(),
        estimatedSessions: z.number().int().min(1).max(100).nullable().optional(),
        courseId: z.string().nullable().optional(),
        bucket: bucket.nullable().optional(),
        kind: z.enum(["internal", "external"]).nullable().optional(),
        reminderLeadDays: z.array(z.number().int().min(0).max(365)).max(10).nullable().optional(),
        weeklyTargetDay: z.number().int().min(0).max(6).nullable().optional(),
        maxChunkMinutes: z.number().int().min(5).max(480).nullable().optional(),
        splittable: z.boolean().nullable().optional(),
        fixedTime: fixedTime.nullable().optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ id, idempotencyKey: key, estimatedSessions, status, weeklyTargetDay, ...input }) =>
      runWrite(ctx, "update_task", key, async () => {
        const task = await ctx.get<Task>("tasks", id);
        if (!task) return fail(`No task with id ${id}.`);
        if (status && task.status === "done") return fail("That task is done; use reopen_task to reopen it.");
        const { set, cleared } = setsAndClears(
          { ...input, ...(estimatedSessions !== undefined ? { estimatedPomodoros: estimatedSessions } : {}) },
          ["description", "dueDate", "estimatedPomodoros", "courseId", "bucket", "kind", "reminderLeadDays", "maxChunkMinutes", "splittable", "fixedTime"]
        );
        const patch: Partial<Task> = { ...(set as Partial<Task>), ...(status ? computeStatusPatch(task, status) : {}) };
        // `weeklyTargetDay: undefined` is the shared clear-field rule (lib/patches.ts), the app's own way to clear it.
        if (weeklyTargetDay === null) patch.weeklyTargetDay = undefined;
        else if (weeklyTargetDay !== undefined) patch.weeklyTargetDay = weeklyTargetDay;

        const nextCourse = cleared.includes("courseId") ? undefined : (patch.courseId ?? task.courseId);
        if (cleared.includes("courseId") && !cleared.includes("bucket") && task.bucket) cleared.push("bucket");
        if (patch.bucket && !nextCourse) return fail("A bucket only means something on a course task: set courseId too.");
        if (patch.courseId && patch.courseId !== task.courseId) {
          const course = await activeCourse(ctx, patch.courseId);
          if (typeof course === "string") return fail(course);
        }
        const nextFixed = cleared.includes("fixedTime") ? undefined : (patch.fixedTime ?? task.fixedTime);
        if (patch.fixedTime && minutesOf(patch.fixedTime.endTime) <= minutesOf(patch.fixedTime.startTime)) return fail("fixedTime must end after it starts.");
        if (nextFixed && patch.splittable === true) return fail("A task with a fixed time is never split; clear fixedTime first.");
        if (patch.fixedTime) patch.splittable = false;
        let note: string | undefined;
        if (patch.maxChunkMinutes !== undefined) {
          const bounds = sittingBounds(await ctx.settings());
          const clamped = Math.min(bounds.maxChunkMinutes, Math.max(bounds.minChunkMinutes, patch.maxChunkMinutes));
          if (clamped !== patch.maxChunkMinutes) note = `maxChunkMinutes was kept inside the sitting bounds (${bounds.minChunkMinutes}–${bounds.maxChunkMinutes}).`;
          patch.maxChunkMinutes = clamped;
        }
        if (Object.keys(patch).length === 0 && cleared.length === 0) return fail("Nothing to change.");
        await writes.updateTask(ctx.uid, id, patch, cleared);
        const after = (await ctx.get<Task>("tasks", id))!;
        const keys = patchKeys(patch as Record<string, unknown>, cleared);
        return {
          result: compact({ updated: taskView(after, { full: true }), note }),
          changes: [{ targetType: "task", targetId: id, title: after.title, ...diff(task, after, keys) }]
        };
      })
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a task",
      description: "Marks a task done, remembering its previous status so reopening restores it. Its unstarted future sittings are taken off the plan, as in the app; the result lists them.",
      inputSchema: z.object({ id: z.string(), idempotencyKey }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ id, idempotencyKey: key }) =>
      runWrite(ctx, "complete_task", key, async () => {
        const task = await ctx.get<Task>("tasks", id);
        if (!task) return fail(`No task with id ${id}.`);
        if (task.status === "done") return { result: { unchanged: `"${task.title}" is already done.` }, changes: [] };
        const patch = computeStatusPatch(task, "done");
        await writes.updateTask(ctx.uid, id, patch);
        const after = (await ctx.get<Task>("tasks", id))!;
        const release = await releaseFinishedWork(ctx, { kind: "task", id });
        return {
          result: compact({ completed: taskView(after), sittingsRemoved: release.released, calendar: release.calendar }),
          changes: [{ targetType: "task", targetId: id, title: after.title, ...diff(task, after, ["status", "completedAt", "previousStatus"]) }, ...release.changes]
        };
      })
  );

  server.registerTool(
    "reopen_task",
    {
      title: "Reopen a task",
      description: "Reopens a done task, back to the status it had before it was finished. Sittings removed when it was finished don't come back; weekly planning proposes what's owed.",
      inputSchema: z.object({ id: z.string(), idempotencyKey }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ id, idempotencyKey: key }) =>
      runWrite(ctx, "reopen_task", key, async () => {
        const task = await ctx.get<Task>("tasks", id);
        if (!task) return fail(`No task with id ${id}.`);
        if (task.status !== "done") return { result: { unchanged: `"${task.title}" isn't done.` }, changes: [] };
        await writes.updateTask(ctx.uid, id, computeStatusPatch(task, "todo"));
        const after = (await ctx.get<Task>("tasks", id))!;
        return { result: { reopened: taskView(after) }, changes: [{ targetType: "task", targetId: id, title: after.title, ...diff(task, after, ["status", "completedAt"]) }] };
      })
  );

  // ---- papers ----
  server.registerTool(
    "create_paper",
    {
      title: "Add a paper",
      description: "Adds a paper to the inbox, to be triaged in the app (queue, shelve or drop). Give a title or a link, plus any metadata you have.",
      inputSchema: z.object({
        title: z.string().max(500).optional(),
        link: z.string().max(2000).optional(),
        authors: z.array(z.string().max(200)).max(50).optional(),
        venue: z.string().max(300).optional(),
        year: z.number().int().min(1800).max(2100).optional(),
        doi: z.string().max(300).optional(),
        tags: z.array(z.string().max(60)).max(30).optional(),
        priority: priority.optional(),
        goal: z.string().max(1000).optional().describe("Why read it — required in the app before the first pass starts."),
        relatedCourseId: z.string().optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ idempotencyKey: key, title, link, ...meta }) =>
      runWrite(ctx, "create_paper", key, async () => {
        if (!title?.trim() && !link?.trim()) return fail("Give the paper a title or a link.");
        if (meta.relatedCourseId && !(await ctx.get<Course>("courses", meta.relatedCourseId))) return fail(`No course with id ${meta.relatedCourseId}.`);
        const paper = { ...inboxPaper({ title, link, source: { kind: link ? "link" : "manual" } }), ...meta, ...(meta.priority ? {} : { priority: "medium" as const }) };
        const id = await writes.createPaper(ctx.uid, paper);
        const created = (await ctx.get<Paper>("papers", id))!;
        const frame = await ctx.frame();
        return { result: { created: paperView(created, frame.today) }, changes: [{ targetType: "paper", targetId: id, title: created.title, before: null, after: paperView(created, frame.today) }] };
      })
  );

  server.registerTool(
    "update_paper",
    {
      title: "Update a paper's details",
      description: "Changes a paper's metadata and reading goal. Pass null to clear an optional field. goalId links the paper to a Goal (list_goals): its reading sittings and focus time then count toward that goal's weekly hours (pace, Workload, weekly planning). `goal` is something else: the reading-goal text asked before a Skim. Status moves (queue, shelve, drop) go through update_paper_status.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(1).max(500).optional(),
        authors: z.array(z.string().max(200)).max(50).optional(),
        venue: z.string().max(300).nullable().optional(),
        year: z.number().int().min(1800).max(2100).nullable().optional(),
        link: z.string().max(2000).nullable().optional(),
        doi: z.string().max(300).nullable().optional(),
        tags: z.array(z.string().max(60)).max(30).optional(),
        priority: priority.optional(),
        goal: z.string().max(1000).nullable().optional(),
        goalKind: z.enum(["survey", "method", "baseline", "related-work", "reproduce", "critique"]).nullable().optional(),
        relatedCourseId: z.string().nullable().optional(),
        goalId: z.string().nullable().optional().describe("The Goal this paper's reading counts toward (an active goal's id), or null to unlink."),
        weeklyTargetDay: z.number().int().min(0).max(6).nullable().optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ id, idempotencyKey: key, weeklyTargetDay, ...input }) =>
      runWrite(ctx, "update_paper", key, async () => {
        const paper = await ctx.get<Paper>("papers", id);
        if (!paper) return fail(`No paper with id ${id}.`);
        const { set, cleared } = setsAndClears(input, ["venue", "year", "link", "doi", "goal", "goalKind", "relatedCourseId", "goalId"]);
        const patch = set as Partial<Paper>;
        if (weeklyTargetDay === null) patch.weeklyTargetDay = undefined;
        else if (weeklyTargetDay !== undefined) patch.weeklyTargetDay = weeklyTargetDay;
        if (patch.relatedCourseId && !(await ctx.get<Course>("courses", patch.relatedCourseId))) return fail(`No course with id ${patch.relatedCourseId}.`);
        if (patch.goalId) {
          const goal = await ctx.get<Goal>("goals", patch.goalId);
          if (!goal) return fail(`No goal with id ${patch.goalId}.`);
          if (goal.status !== "active") return fail(`"${goal.title}" is ${goal.status}; link a paper to an active goal.`);
        }
        if (Object.keys(patch).length === 0 && cleared.length === 0) return fail("Nothing to change.");
        await writes.updatePaper(ctx.uid, id, patch, cleared);
        const after = (await ctx.get<Paper>("papers", id))!;
        const frame = await ctx.frame();
        return { result: { updated: paperView(after, frame.today) }, changes: [{ targetType: "paper", targetId: id, title: after.title, ...diff(paper, after, patchKeys(patch as Record<string, unknown>, cleared)) }] };
      })
  );

  server.registerTool(
    "update_paper_status",
    {
      title: "Queue, shelve, drop or restore a paper",
      description:
        "Moves a paper the way the app's buttons do: queue (onto the end of Up next, out of the inbox, off the shelf), unqueue, shelve (until a date, default 30 days), drop (from any status; undo with restore), restore (undo a drop). Status and progress are recomputed, never set by hand.",
      inputSchema: z.object({ id: z.string(), action: z.enum(["queue", "unqueue", "shelve", "drop", "restore"]), until: dateKey.optional().describe("Shelve until this date."), idempotencyKey }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ id, action, until, idempotencyKey: key }) =>
      runWrite(ctx, "update_paper_status", key, async () => {
        const paper = await ctx.get<Paper>("papers", id);
        if (!paper) return fail(`No paper with id ${id}.`);
        const frame = await ctx.frame();
        const nowIso = new Date().toISOString();
        const status = derivePaperStatus(paper);
        let patch: Partial<Paper>;
        if (action === "queue") {
          if (status === "dropped") return fail(`"${paper.title}" is dropped; restore it first.`);
          if (status === "read") return fail(`"${paper.title}" is already read.`);
          patch = queuePatch(paper, nowIso);
        } else if (action === "unqueue") {
          if (!paper.queuedAt) return { result: { unchanged: `"${paper.title}" isn't in Up next.` }, changes: [] };
          patch = unqueuePatch(paper);
        } else if (action === "shelve") {
          const date = until ?? addDaysToKey(frame.today, DEFAULT_SHELF_DAYS);
          if (date <= frame.today) return fail("Shelve until a date after today.");
          patch = shelvePatch(paper, date);
        } else if (action === "drop") {
          if (status === "dropped") return { result: { unchanged: `"${paper.title}" is already dropped.` }, changes: [] };
          patch = dropPatch(paper, nowIso);
        } else {
          if (!paper.droppedAt) return fail(status === "dropped" ? `"${paper.title}" was dropped by its own Skim verdict, which restore doesn't undo; change it in the app.` : `"${paper.title}" isn't dropped.`);
          patch = restorePatch(paper);
        }
        await writes.updatePaper(ctx.uid, id, patch);
        const after = (await ctx.get<Paper>("papers", id))!;
        return { result: { updated: paperView(after, frame.today) }, changes: [{ targetType: "paper", targetId: id, title: after.title, ...diff(paper, after, patchKeys(patch as Record<string, unknown>)) }] };
      })
  );

  server.registerTool(
    "add_paper_note",
    {
      title: "Add a note to a paper",
      description: "Adds a note (quote, idea, question, critique or todo) to a paper, optionally tied to a pass, a page and a quoted passage. Highlights on the PDF need its coordinates and can only be made in the reader.",
      inputSchema: z.object({
        paperId: z.string(),
        body: z.string().min(1).max(5000),
        kind: z.enum(["quote", "idea", "question", "critique", "todo"]).optional(),
        passNo: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        page: z.number().int().min(1).optional(),
        quote: z.string().max(2000).optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ paperId, body, kind, passNo, page, quote, idempotencyKey: key }) =>
      runWrite(ctx, "add_paper_note", key, async () => {
        const paper = await ctx.get<Paper>("papers", paperId);
        if (!paper) return fail(`No paper with id ${paperId}.`);
        const note = { paperId, body: body.trim(), kind: kind ?? "idea", passNo, anchorPage: page, anchorQuote: quote };
        const id = await writes.createPaperNote(ctx.uid, paperId, note);
        return { result: { added: compact({ id, paper: paper.title, kind: note.kind, body: note.body }) }, changes: [{ targetType: "paperNote", targetId: `${paperId}/${id}`, title: paper.title, before: null, after: compact({ ...note }) }] };
      })
  );

  // ---- courses: assessments and class logs ----
  server.registerTool(
    "create_checkpoint",
    {
      title: "Add an assessment",
      description: "Adds an assessment (quiz, lab, assignment, midsem, endsem, presentation, other) to an active course. Prep settings default by type, as in the app's form.",
      inputSchema: z.object({
        courseId: z.string(),
        title: z.string().min(1).max(300),
        type: z.enum(["quiz", "lab", "assignment", "midsem", "endsem", "presentation", "other"]),
        dueAt: dateKey,
        weightPct: z.number().min(0).max(100).optional(),
        requiresPrep: z.boolean().optional(),
        prepLeadDays: z.number().int().min(0).max(120).optional(),
        prepEstimateMin: z.number().int().min(0).max(10_000).optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ courseId, title, type, dueAt, weightPct, requiresPrep, prepLeadDays, prepEstimateMin, idempotencyKey: key }) =>
      runWrite(ctx, "create_checkpoint", key, async () => {
        const course = await activeCourse(ctx, courseId);
        if (typeof course === "string") return fail(course);
        const defaults = CHECKPOINT_TYPE_DEFAULTS[type];
        const checkpoint = {
          courseId,
          type,
          title: title.trim(),
          dueAt,
          weightPct,
          requiresPrep: requiresPrep ?? defaults.requiresPrep,
          prepLeadDays: prepLeadDays ?? defaults.prepLeadDays,
          prepEstimateMin: prepEstimateMin ?? defaults.prepEstimateMin,
          topicIds: [],
          status: "upcoming" as const
        };
        const id = await writes.createCheckpoint(ctx.uid, courseId, checkpoint);
        return { result: { created: compact({ id, course: course.name, ...checkpoint, courseId: undefined }) }, changes: [{ targetType: "checkpoint", targetId: `${courseId}/${id}`, title: checkpoint.title, before: null, after: compact({ ...checkpoint }) }] };
      })
  );

  server.registerTool(
    "update_checkpoint",
    {
      title: "Update an assessment",
      description: "Changes an assessment: details, status (upcoming, prepping, submitted, done, missed) or its result. Moving it to submitted, done or missed takes its unstarted future prep sittings off the plan, as in the app.",
      inputSchema: z.object({
        courseId: z.string(),
        id: z.string(),
        title: z.string().min(1).max(300).optional(),
        type: z.enum(["quiz", "lab", "assignment", "midsem", "endsem", "presentation", "other"]).optional(),
        dueAt: dateKey.optional(),
        status: z.enum(["upcoming", "prepping", "submitted", "done", "missed"]).optional(),
        weightPct: z.number().min(0).max(100).nullable().optional(),
        requiresPrep: z.boolean().optional(),
        prepLeadDays: z.number().int().min(0).max(120).optional(),
        prepEstimateMin: z.number().int().min(0).max(10_000).optional(),
        result: z.object({ score: z.number(), max: z.number().positive(), notes: z.string().max(2000).optional() }).nullable().optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ courseId, id, idempotencyKey: key, ...input }) =>
      runWrite(ctx, "update_checkpoint", key, async () => {
        const blocked = await requireModule(ctx, "courses", "Courses");
        if (blocked) return blocked;
        const [course] = await Promise.all([ctx.get<Course>("courses", courseId)]);
        if (!course) return fail(`No course with id ${courseId}.`);
        const all = await ctx.sub<Checkpoint>("courses", courseId, "checkpoints");
        const before = all.find((c) => c.id === id);
        if (!before) return fail(`No assessment with id ${id} on "${course.name}".`);
        const { set, cleared } = setsAndClears(input, ["weightPct", "result"]);
        if (Object.keys(set).length === 0 && cleared.length === 0) return fail("Nothing to change.");
        await writes.updateCheckpoint(ctx.uid, courseId, id, set as Partial<Checkpoint>, cleared);
        const after = (await ctx.sub<Checkpoint>("courses", courseId, "checkpoints")).find((c) => c.id === id)!;
        const finished = (s: string) => s === "submitted" || s === "done" || s === "missed";
        const release = input.status && finished(input.status) && !finished(before.status) ? await releaseFinishedWork(ctx, { kind: "checkpoint", id }) : null;
        const changes: ActivityChange[] = [{ targetType: "checkpoint", targetId: `${courseId}/${id}`, title: after.title, ...diff(before, after, patchKeys(set, cleared)) }, ...(release?.changes ?? [])];
        return { result: compact({ updated: compact({ ...after, createdAt: undefined }), sittingsRemoved: release?.released, calendar: release?.calendar }), changes };
      })
  );

  server.registerTool(
    "log_class",
    {
      title: "Log a class",
      description:
        "Records one class of a course, exactly as the app's Log a class does: attendance, topics covered (comma, semicolon or newline separated), understanding 1-5, notes. New topics are created and get their first revision card from the understanding rating; a topic already logged is matched by name. A missed class adds a high-priority catch-up task. Re-logging the same date merges into it.",
      inputSchema: z.object({
        courseId: z.string(),
        date: dateKey,
        attendance: z.enum(["attended", "missed", "cancelled", "self_study"]),
        topics: z.string().max(3000).optional(),
        understanding: z.number().int().min(1).max(5).optional(),
        notes: z.string().max(5000).optional(),
        durationMin: z.number().int().min(1).max(600).optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ courseId, date, attendance, topics: rawTopics, understanding, notes, durationMin, idempotencyKey: key }) =>
      runWrite(ctx, "log_class", key, async () => {
        const blocked = await requireModule(ctx, "courses", "Courses");
        if (blocked) return blocked;
        const course = await ctx.get<Course>("courses", courseId);
        if (!course) return fail(`No course with id ${courseId}.`);
        const frame = await ctx.frame();
        if (effectiveCourseStatus(course, frame.today) === "dropped") return fail(`"${course.name}" was dropped.`);
        if (date > frame.today) return fail("A class can only be logged once it has happened.");
        // lib/classlog.ts `saveClassLogEntry`, for the Admin SDK.
        const titles = splitTopics(rawTopics ?? "");
        const existingTopics = (await ctx.list<Topic>("topics")).filter((topic) => topic.courseId === courseId);
        const confidence = attendance === "missed" ? 1 : (understanding ?? 3);
        const topicIds: string[] = [];
        const created: string[] = [];
        const now = new Date().toISOString();
        const seedRevision = async (topicId: string, title: string) => {
          const { ladderIndex, dueDate } = topicRevisionSeed(confidence, date);
          const ref = await userCol(ctx.uid, "revisionItems").add({ kind: "topic", refId: topicId, courseId, title, ladderIndex, dueDate, reps: 0, lapses: 0, suspended: false, createdAt: now, updatedAt: now });
          await userCol(ctx.uid, "topics").doc(topicId).update({ revisionItemId: ref.id, updatedAt: now });
          ctx.meter.writes += 2;
        };
        for (const title of titles) {
          const existing = existingTopics.find((topic) => topic.title.toLowerCase() === title.toLowerCase());
          if (existing) {
            await userCol(ctx.uid, "topics").doc(existing.id).update({ confidence, classLogIds: Array.from(new Set([...existing.classLogIds, date])), updatedAt: now });
            ctx.meter.writes += 1;
            topicIds.push(existing.id);
            if (!existing.revisionItemId) await seedRevision(existing.id, existing.title);
          } else {
            const ref = await userCol(ctx.uid, "topics").add({ courseId, title, firstSeenDate: date, classLogIds: [date], confidence, status: "active", createdAt: now, updatedAt: now });
            ctx.meter.writes += 1;
            topicIds.push(ref.id);
            created.push(title);
            await seedRevision(ref.id, title);
          }
        }
        const previous = (await ctx.sub<ClassLog>("courses", courseId, "classLogs")).find((log) => log.id === date) ?? null;
        const log = { courseId, date, attendance, topicIds, rawTopics: rawTopics || undefined, understanding: attendance === "missed" ? undefined : understanding, notes: notes || undefined, durationMin };
        await writes.saveClassLog(ctx.uid, courseId, log);
        let catchUp: string | undefined;
        if (attendance === "missed") {
          catchUp = titles.length > 0 ? `Catch up: ${course.name} — ${titles.join(", ")}` : `Catch up: ${course.name} (${date})`;
          await writes.createTask(ctx.uid, { title: catchUp, status: "todo", priority: "high", category: "admin" });
          ctx.meter.writes += 1;
        }
        return {
          result: compact({ logged: compact({ course: course.name, ...log, courseId: undefined }), newTopics: created, catchUpTask: catchUp }),
          changes: [{ targetType: "classLog", targetId: `${courseId}/${date}`, title: `${course.name} ${date}`, before: previous ? compact({ ...previous }) : null, after: compact({ ...log }) }]
        };
      })
  );

  // ---- goals ----
  server.registerTool(
    "create_goal",
    {
      title: "Create a goal",
      description: "Adds a long-horizon goal (week, term, break, year, phd) with a definition of done, optional milestones and weekly hours target, and links to courses.",
      inputSchema: z.object({
        title: z.string().min(1).max(300),
        horizon: z.enum(["week", "term", "break", "year", "phd"]).optional(),
        definitionOfDone: z.string().min(1).max(2000),
        why: z.string().max(2000).optional(),
        termId: z.string().optional().describe("Only for a break-horizon goal: the break term it belongs to."),
        targetHoursPerWeek: z.number().min(0).max(80).optional(),
        milestones: z.array(z.object({ title: z.string().min(1).max(300), dueAt: dateKey.optional() })).max(30).optional(),
        linkedCourseIds: z.array(z.string()).max(20).optional(),
        reviewCadence: z.enum(["weekly", "monthly"]).optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ idempotencyKey: key, ...input }) =>
      runWrite(ctx, "create_goal", key, async () => {
        const blocked = await requireModule(ctx, "goals", "Goals");
        if (blocked) return blocked;
        const horizon = input.horizon ?? "term";
        for (const courseId of input.linkedCourseIds ?? []) {
          const course = await activeCourse(ctx, courseId);
          if (typeof course === "string") return fail(course);
        }
        const goal = {
          title: input.title.trim(),
          horizon,
          termId: horizon === "break" ? input.termId : undefined,
          why: input.why,
          definitionOfDone: input.definitionOfDone,
          milestones: (input.milestones ?? []).map((m) => compact({ id: crypto.randomUUID(), title: m.title, dueAt: m.dueAt, done: false }) as GoalMilestone),
          linked: { courseIds: input.linkedCourseIds ?? [], paperIds: [], taskIds: [], goalIds: [] },
          targetHoursPerWeek: input.targetHoursPerWeek,
          status: "active" as const,
          reviewCadence: input.reviewCadence ?? "weekly"
        };
        const id = await writes.createGoal(ctx.uid, goal);
        return { result: { created: compact({ id, ...goal }) }, changes: [{ targetType: "goal", targetId: id, title: goal.title, before: null, after: compact({ ...goal }) }] };
      })
  );

  server.registerTool(
    "update_goal",
    {
      title: "Update a goal",
      description: "Changes a goal's details or status (active, paused, achieved, dropped). Moving it out of active takes its unstarted future sittings off the plan, as in the app. markReviewed records a review now. Milestones change through update_milestone.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(1).max(300).optional(),
        horizon: z.enum(["week", "term", "break", "year", "phd"]).optional(),
        definitionOfDone: z.string().min(1).max(2000).optional(),
        why: z.string().max(2000).nullable().optional(),
        targetHoursPerWeek: z.number().min(0).max(80).nullable().optional(),
        status: z.enum(["active", "paused", "achieved", "dropped"]).optional(),
        linkedCourseIds: z.array(z.string()).max(20).optional(),
        reviewCadence: z.enum(["weekly", "monthly"]).optional(),
        markReviewed: z.boolean().optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ id, idempotencyKey: key, linkedCourseIds, markReviewed, ...input }) =>
      runWrite(ctx, "update_goal", key, async () => {
        const blocked = await requireModule(ctx, "goals", "Goals");
        if (blocked) return blocked;
        const goal = await ctx.get<Goal>("goals", id);
        if (!goal) return fail(`No goal with id ${id}.`);
        const { set, cleared } = setsAndClears(input, ["why", "targetHoursPerWeek"]);
        if (linkedCourseIds) {
          for (const courseId of linkedCourseIds.filter((c) => !goal.linked?.courseIds?.includes(c))) {
            const course = await activeCourse(ctx, courseId);
            if (typeof course === "string") return fail(course);
          }
          set.linked = { ...goal.linked, courseIds: linkedCourseIds };
        }
        if (markReviewed) set.lastReviewedAt = new Date().toISOString();
        if (Object.keys(set).length === 0 && cleared.length === 0) return fail("Nothing to change.");
        await writes.updateGoal(ctx.uid, id, set as Partial<Goal>, cleared);
        const after = (await ctx.get<Goal>("goals", id))!;
        const release = input.status && input.status !== "active" && goal.status === "active" ? await releaseFinishedWork(ctx, { kind: "goal", id }) : null;
        return {
          result: compact({ updated: compact({ id, title: after.title, status: after.status, horizon: after.horizon, targetHoursPerWeek: after.targetHoursPerWeek }), sittingsRemoved: release?.released, calendar: release?.calendar }),
          changes: [{ targetType: "goal", targetId: id, title: after.title, ...diff(goal, after, patchKeys(set, cleared)) }, ...(release?.changes ?? [])]
        };
      })
  );

  server.registerTool(
    "update_milestone",
    {
      title: "Add or update a goal milestone",
      description: "Adds a milestone to a goal (omit milestoneId) or changes one: title, due date (null clears), done. Ticking a milestone done takes its unstarted future sittings off the plan, as in the app.",
      inputSchema: z.object({
        goalId: z.string(),
        milestoneId: z.string().optional(),
        title: z.string().min(1).max(300).optional(),
        dueAt: dateKey.nullable().optional(),
        done: z.boolean().optional(),
        idempotencyKey
      }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ goalId, milestoneId, title, dueAt, done, idempotencyKey: key }) =>
      runWrite(ctx, "update_milestone", key, async () => {
        const blocked = await requireModule(ctx, "goals", "Goals");
        if (blocked) return blocked;
        const goal = await ctx.get<Goal>("goals", goalId);
        if (!goal) return fail(`No goal with id ${goalId}.`);
        let milestones: GoalMilestone[];
        let target: GoalMilestone;
        if (!milestoneId) {
          if (!title) return fail("A new milestone needs a title.");
          target = compact({ id: crypto.randomUUID(), title: title.trim(), dueAt: dueAt ?? undefined, done: done ?? false }) as GoalMilestone;
          milestones = [...goal.milestones, target];
        } else {
          const existing = goal.milestones.find((m) => m.id === milestoneId);
          if (!existing) return fail(`"${goal.title}" has no milestone ${milestoneId}.`);
          const { dueAt: _old, ...rest } = existing;
          target = { ...(dueAt === null ? rest : existing), ...(title ? { title: title.trim() } : {}), ...(dueAt ? { dueAt } : {}), ...(done !== undefined ? { done } : {}) };
          milestones = goal.milestones.map((m) => (m.id === milestoneId ? target : m));
        }
        await writes.updateGoal(ctx.uid, goalId, { milestones });
        const before = goal.milestones.find((m) => m.id === target.id) ?? null;
        const release = before && !before.done && target.done ? await releaseFinishedWork(ctx, { kind: "goal", id: goalId, milestoneId: target.id }) : null;
        return {
          result: compact({ goal: goal.title, milestone: target, sittingsRemoved: release?.released, calendar: release?.calendar }),
          changes: [{ targetType: "milestone", targetId: `${goalId}/${target.id}`, title: target.title, before: before ? { ...before } : null, after: { ...target } }, ...(release?.changes ?? [])]
        };
      })
  );

  // ---- day off ----
  const dayOffGuard = async (date: string): Promise<string | null> => {
    const frame = await ctx.frame();
    if (date < frame.today) return "Past days are read-only through this connection.";
    const day = await ctx.get<Day>("days", date);
    if (day?.closedAt || day?.session?.endedAt) return `${date} is already closed.`;
    return null;
  };

  server.registerTool(
    "set_day_off",
    {
      title: "Mark a day off",
      description: "Marks today or a future date as a day off, with an optional reason. Workload asks nothing of it, Up next says so, and weekly planning leaves it empty.",
      inputSchema: z.object({ date: dateKey, reason: z.string().max(300).optional(), idempotencyKey }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ date, reason, idempotencyKey: key }) =>
      runWrite(ctx, "set_day_off", key, async () => {
        const refused = await dayOffGuard(date);
        if (refused) return fail(refused);
        const before = await ctx.get<Day>("days", date);
        const dayOff = compact({ reason, markedAt: new Date().toISOString() });
        await writes.saveDayFields(ctx.uid, date, { dayOff });
        return { result: { dayOff: { date, ...dayOff } }, changes: [{ targetType: "day", targetId: date, title: date, before: { dayOff: before?.dayOff ?? null }, after: { dayOff } }] };
      })
  );

  server.registerTool(
    "clear_day_off",
    {
      title: "Clear a day off",
      description: "Turns a day off back into an ordinary day (today or later).",
      inputSchema: z.object({ date: dateKey, idempotencyKey }),
      annotations: WRITE,
      scopeChallenge: needsWrite
    },
    async ({ date, idempotencyKey: key }) =>
      runWrite(ctx, "clear_day_off", key, async () => {
        const refused = await dayOffGuard(date);
        if (refused) return fail(refused);
        const before = await ctx.get<Day>("days", date);
        if (!before?.dayOff) return { result: { unchanged: `${date} isn't a day off.` }, changes: [] };
        await writes.saveDayFields(ctx.uid, date, { dayOff: writes.deleteSentinel() });
        return { result: { cleared: date }, changes: [{ targetType: "day", targetId: date, title: date, before: { dayOff: before.dayOff }, after: { dayOff: null } }] };
      })
  );

}
