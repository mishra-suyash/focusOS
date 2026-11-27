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
import { getConnection, runGoogleCalendarPush } from "@/lib/google-calendar-admin";
import { fail, ok, type ToolContext } from "@/lib/mcp/context";
import { sittingsOfFinishedWork, type FinishedWork } from "@/lib/weekplan";
import type { DailySchedule, PomodoroSession } from "@/types";

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

/** Best-effort, like the autosave's: a failed push never fails the write; the result says what happened. */
export async function pushCalendar(uid: string): Promise<string> {
  try {
    const connection = await getConnection(uid);
    if (!connection?.connected || !connection.focusOsCalendarId) return "Google Calendar isn't connected; nothing to push.";
    const counts = await runGoogleCalendarPush(uid);
    return `Pushed to Google Calendar (${counts.created} created, ${counts.updated} updated, ${counts.deleted} removed).`;
  } catch (error) {
    return `The change is saved, but the Google Calendar push failed: ${error instanceof Error ? error.message : "unknown error"}. The nightly sync will retry.`;
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
  if (released.length === 0) return { released: [] as { date: string; title: string; startTime: string; endTime: string }[], calendar: undefined, changes: [] as ActivityChange[] };
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
