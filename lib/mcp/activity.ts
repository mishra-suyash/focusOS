/**
 * plan/19 §5.3 — what every MCP write does besides the write itself:
 * - refuses a token without the `write` scope;
 * - replays the stored result for a repeated `idempotencyKey` instead of writing twice;
 * - records itself in `users/{uid}/mcpActivity` with the fields it changed, before and after, so the
 *   person can see exactly what Claude did (Settings → Connected apps);
 * - counts toward the monthly usage document.
 * Plus the two side effects schedule-touching writes share with the app: giving finished work's future
 * sittings back (`useReleaseSittings`) and the best-effort Google Calendar push the autosave triggers.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { userCol, removeSittings } from "@/lib/admin-writes";
import { getConnection, previewGoogleCalendarPush, runGoogleCalendarPush, type PushOutcome } from "@/lib/google-calendar-admin";
import { compact, fail, ok, type ToolContext } from "@/lib/mcp/context";
import { sittingsOfFinishedWork, type FinishedWork } from "@/lib/weekplan";
import type { DailySchedule, PomodoroSession, ScheduleSlot } from "@/types";

export interface ActivityChange {
  targetType: string;
  targetId: string;
  title?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface WriteOutcome {
  result: unknown;
  changes: ActivityChange[];
}

/** The fields a write touched, as they were and as they are. A deleted field reads as null. */
export function diff(before: object | null, after: object | null, keys: string[]) {
  const pick = (doc: object | null) => {
    if (!doc) return null;
    const record = doc as Record<string, unknown>;
    return Object.fromEntries(keys.map((key) => [key, record[key] === undefined ? null : record[key]]));
  };
  return { before: pick(before), after: pick(after) };
}

/** The keys of a patch, minus bookkeeping. */
export function patchKeys(patch: Record<string, unknown>, cleared: string[] = []): string[] {
  return [...new Set([...Object.keys(patch), ...cleared])].filter((key) => key !== "updatedAt");
}

function activityId(tool: string, key: string) {
  return `idem_${createHash("sha256").update(`${tool}:${key}`).digest("hex").slice(0, 40)}`;
}

export async function runWrite(ctx: ToolContext, tool: string, idempotencyKey: string | undefined, write: () => Promise<WriteOutcome | CallToolResult>): Promise<CallToolResult> {
  if (!ctx.caller.scopes.includes("write")) {
    return fail("This connection can only read. Reconnect FocusLab and allow \"Make changes\" to let Claude edit.");
  }
  const activity = userCol(ctx.uid, "mcpActivity");
  const docRef = idempotencyKey ? activity.doc(activityId(tool, idempotencyKey)) : activity.doc();
  if (idempotencyKey) {
    const previous = await docRef.get();
    ctx.meter.reads += 1;
    if (previous.exists) return ok({ replayed: "This idempotencyKey was already used; nothing was written again.", result: JSON.parse((previous.data()?.result as string) ?? "null") });
  }
  const outcome = await write();
  if ("content" in outcome) return outcome;
  const at = new Date().toISOString();
  const entries = outcome.changes.length > 0 ? outcome.changes : [{ targetType: "none", targetId: "" }];
  const [first, ...rest] = entries;
  const base = { at, tool, clientId: ctx.caller.clientId, clientName: ctx.caller.clientName, tokenKind: ctx.caller.tokenKind };
  await docRef.set({ ...base, ...first, ...(idempotencyKey ? { idempotencyKey, result: JSON.stringify(outcome.result) } : {}), ...(rest.length > 0 ? { more: rest } : {}) });
  ctx.meter.writes += 1;
  return ok(outcome.result);
}

export type CalendarMode = "push" | "skip" | "dryRun";

/**
 * What a push did (or, for a dry run, would do), named: the push reconciles the whole 14-day window,
 * not only the day just edited, so anything it creates or removes elsewhere is listed by title and
 * date rather than hidden in a count. Only events FocusOS created in its own calendar are ever removed.
 */
function describePush(outcome: PushOutcome, date: string | undefined, verb: "Pushed" | "Would push") {
  const named = (action: "create" | "delete", here: boolean) =>
    outcome.items
      .filter((item) => item.action === action && (date === undefined || (item.date === date) === here))
      .map((item) => compact({ title: item.title ?? "(untitled)", date: item.date, kind: item.kind }));
  return compact({
    summary: `${verb} to Google Calendar: ${outcome.created} created, ${outcome.updated} updated, ${outcome.deleted} removed.`,
    created: named("create", true),
    removed: named("delete", true),
    otherDates: date
      ? compact({
          note: "The push reconciles every FocusOS event in its window, so these changes were on other dates (an unsaved edit elsewhere, a finished task, a block removed in the app). Only events FocusOS created are ever removed.",
          created: named("create", false),
          removed: named("delete", false)
        })
      : undefined
  });
}

/** Best-effort, like the autosave's: a failed push never fails the write; the result says what happened. */
export async function pushCalendar(uid: string, opts: { mode?: CalendarMode; date?: string; override?: { dateKey: string; slots: ScheduleSlot[] } } = {}): Promise<unknown> {
  const mode = opts.mode ?? "push";
  try {
    const connection = await getConnection(uid);
    if (!connection?.connected || !connection.focusOsCalendarId) return "Google Calendar isn't connected; nothing to push.";
    if (mode === "skip") return "Not pushed to Google Calendar (calendar: \"skip\"). The next sync from the app or the scheduled sync will push it.";
    if (mode === "dryRun") return describePush(await previewGoogleCalendarPush(uid, { override: opts.override }), opts.date, "Would push");
    return describePush(await runGoogleCalendarPush(uid, { nameRemovals: true }), opts.date, "Pushed");
  } catch (error) {
    return mode === "dryRun"
      ? `Couldn't preview the Google Calendar push: ${error instanceof Error ? error.message : "unknown error"}.`
      : `The change is saved, but the Google Calendar push failed: ${error instanceof Error ? error.message : "unknown error"}. The scheduled sync will retry.`;
  }
}

/**
 * Finished or stopped work gives its unstarted future sittings back, exactly as the app does on the same
 * action (hooks/use-release-sittings.ts), measured from the person's own clock.
 */
export async function releaseFinishedWork(ctx: ToolContext, work: FinishedWork) {
  const frame = await ctx.frame();
  const [schedules, sessions] = await Promise.all([ctx.list<DailySchedule>("dailySchedules"), ctx.list<PomodoroSession>("pomodoroSessions")]);
  const released = sittingsOfFinishedWork({ schedules, work, todayKey: frame.scheduleDay, nowMinutes: frame.minute, sessions });
  if (released.length === 0) return { released: [] as { date: string; title: string; startTime: string; endTime: string }[], calendar: undefined as unknown, changes: [] as ActivityChange[] };
  const touched = await removeSittings(ctx.uid, released);
  ctx.meter.writes += touched.length;
  const calendar = await pushCalendar(ctx.uid);
  const list = released.map((item) => ({ date: item.dateKey, title: item.slot.title, startTime: item.slot.startTime, endTime: item.slot.endTime }));
  const changes: ActivityChange[] = released.map((item) => ({
    targetType: "block",
    targetId: `${item.dateKey}/${item.slot.id}`,
    title: item.slot.title,
    before: { date: item.dateKey, startTime: item.slot.startTime, endTime: item.slot.endTime },
    after: null
  }));
  return { released: list, calendar, changes };
}
