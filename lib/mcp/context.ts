/**
 * plan/19 §3/§4.3 — what every tool handler gets: the caller (whose uid scopes every path), one user's
 * data reached only through that uid, the user's day frame, and a meter that lands MCP traffic in the
 * same monthly usage document the app's own meter writes (§5.3).
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { dayFrame, fetchSettings, type DayFrame } from "@/lib/admin-dailyloop";
import { userCol } from "@/lib/admin-writes";
import { resolveEnabledModules, type ModuleId } from "@/lib/features";
import type { McpCaller } from "@/lib/mcp/auth";
import type { UserSettings } from "@/types";

/** claude.ai caps a tool result at about 150,000 characters; every result stays well under it. */
export const RESULT_BUDGET_CHARS = 120_000;

export interface ToolContext {
  caller: McpCaller;
  uid: string;
  meter: { reads: number; writes: number };
  settings: () => Promise<Partial<UserSettings>>;
  frame: () => Promise<DayFrame>;
  modules: () => Promise<Set<ModuleId>>;
  /** Every document in one of the user's collections (`users/{uid}/{name}`). */
  list: <T>(name: string) => Promise<(T & { id: string })[]>;
  get: <T>(name: string, id: string) => Promise<(T & { id: string }) | null>;
  /** A subcollection under one of the user's documents, e.g. `courses/{id}/checkpoints`. */
  sub: <T>(parent: string, parentId: string, name: string) => Promise<(T & { id: string })[]>;
}

/** A Firestore id is one path segment. An id with a "/" would address a nested path; it is never a real id here. */
export function isPlainId(id: string): boolean {
  return id.length > 0 && id.length <= 1500 && !id.includes("/") && id !== "." && id !== "..";
}

export function createToolContext(caller: McpCaller): ToolContext {
  const uid = caller.uid;
  const meter = { reads: 0, writes: 0 };
  let settingsPromise: Promise<Partial<UserSettings>> | null = null;
  const settings = () => {
    if (!settingsPromise) {
      meter.reads += 1;
      settingsPromise = fetchSettings(uid);
    }
    return settingsPromise;
  };
  return {
    caller,
    uid,
    meter,
    settings,
    frame: async () => dayFrame(await settings()),
    modules: async () => resolveEnabledModules(await settings()),
    list: async <T,>(name: string) => {
      const snapshot = await userCol(uid, name).get();
      meter.reads += Math.max(1, snapshot.size);
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as T & { id: string });
    },
    get: async <T,>(name: string, id: string) => {
      if (!isPlainId(id)) return null;
      const snapshot = await userCol(uid, name).doc(id).get();
      meter.reads += 1;
      return snapshot.exists ? ({ id: snapshot.id, ...snapshot.data() } as T & { id: string }) : null;
    },
    sub: async <T,>(parent: string, parentId: string, name: string) => {
      if (!isPlainId(parentId)) return [];
      const snapshot = await userCol(uid, parent).doc(parentId).collection(name).get();
      meter.reads += Math.max(1, snapshot.size);
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as T & { id: string });
    }
  };
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** A refusal Claude can read and relay: the write was not made, and why. */
export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export async function requireModule(ctx: ToolContext, moduleId: ModuleId, label: string): Promise<CallToolResult | null> {
  return (await ctx.modules()).has(moduleId) ? null : fail(`The ${label} module is turned off in this person's FocusLab settings, so there's nothing to show or change there.`);
}

/**
 * Pages a list so each result stays under the budget. The cursor is an opaque offset; the result says
 * how many are left so Claude knows to ask again.
 */
export function paginate<T>(items: T[], cursor: string | undefined, limit: number, budget = RESULT_BUDGET_CHARS) {
  const start = cursor ? Math.max(0, Number(Buffer.from(cursor, "base64url").toString("utf-8")) || 0) : 0;
  const page: T[] = [];
  let used = 0;
  for (let i = start; i < items.length && page.length < limit; i += 1) {
    const size = JSON.stringify(items[i]).length + 1;
    if (page.length > 0 && used + size > budget) break;
    page.push(items[i]);
    used += size;
  }
  const next = start + page.length;
  return {
    items: page,
    total: items.length,
    ...(next < items.length ? { nextCursor: Buffer.from(String(next), "utf-8").toString("base64url"), more: `${items.length - next} more — pass nextCursor to continue.` } : {})
  };
}

/** Drops keys whose value is undefined, null, or an empty array — fewer characters for Claude to read. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && !(Array.isArray(item) && item.length === 0))) as Partial<T>;
}
