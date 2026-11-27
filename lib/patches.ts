/**
 * plan/19 §5.1 — the write rules every writer of a task or a paper must keep, as pure payload
 * builders. Both SDKs use them: `lib/firestore.ts` (the client SDK, the app) and `lib/admin-writes.ts`
 * (the Admin SDK, the MCP server). No Firebase import here — each caller passes its own delete
 * sentinel (`deleteField()` on the client, `FieldValue.delete()` on the server).
 *
 * Why it matters: "pass `undefined` to clear a field" is how the app's patch helpers say "delete"
 * (`computeStatusPatch`, `lib/papers.ts`' exit patches). Plain `withoutUndefined` would drop those
 * keys, and the Admin SDK's `ignoreUndefinedProperties` silently does the same, so a port that
 * didn't go through here would leave "Reopen" or "Undo drop" doing nothing at all.
 */
import type { Paper, Task } from "@/types";

export function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, cleanValue(item)])
  );
}

export function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cleanValue(item));
  if (value && typeof value === "object" && value.constructor === Object) {
    return withoutUndefined(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Turns dot-path keys (`"session.startedAt"`) into a real nested object (`{session: {startedAt}}`)
 * — the shape a brand-new document needs, since only `update` parses a dotted key as a field path,
 * and it only works on a document that already exists. True of both SDKs (see `saveDayFields`).
 */
export function expandDotPaths(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const parts = key.split(".");
    let node = result;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  }
  return result;
}

/** Task fields that `undefined` clears. Every other optional field passed as `undefined` is omitted. */
const TASK_CLEARED_BY_UNDEFINED = ["completedAt", "weeklyTargetDay"] as const;

/** `updateTask`'s payload: the patch, `updatedAt`, and the clear-field rule above. */
export function taskPatch(patch: Partial<Task>, del: unknown, nowIso: string): Record<string, unknown> {
  const payload: Record<string, unknown> = withoutUndefined({ ...patch, updatedAt: nowIso });
  for (const key of TASK_CLEARED_BY_UNDEFINED) {
    if (key in patch && patch[key] === undefined) payload[key] = del;
  }
  return payload;
}

/**
 * Paper fields that `undefined` clears. plan/17 §5.2 — the shelf/queue/drop/inbox fields are cleared
 * by passing `undefined` (the exit patches in lib/papers.ts do), so without this "Read now" or "Undo
 * drop" would do nothing. `shelvedUntil: null` is a real value and is kept.
 */
const PAPER_CLEARED_BY_UNDEFINED = ["readAt", "fileId", "weeklyTargetDay", "queuedAt", "shelvedUntil", "droppedAt", "inbox"] as const;

/** `updatePaper`'s payload: the patch, `updatedAt`, the clear-field rule, and the attached-PDF invalidation. */
export function paperPatch(patch: Partial<Paper>, del: unknown, nowIso: string): Record<string, unknown> {
  const payload: Record<string, unknown> = withoutUndefined({ ...patch, updatedAt: nowIso });
  for (const key of PAPER_CLEARED_BY_UNDEFINED) {
    if (key in patch && patch[key] === undefined) payload[key] = del;
  }
  // Replacing or removing the attached PDF invalidates any cached Anthropic file reference and the
  // layered notes generated from it — a stale summary of a since-replaced PDF would be actively
  // misleading, not just outdated. A `fileId` in the patch wins over anything passed alongside it.
  if ("fileId" in patch) {
    payload.anthropicFileId = del;
    payload.layeredNotes = del;
  }
  if ("anthropicFileId" in patch && patch.anthropicFileId === undefined) payload.anthropicFileId = del;
  if ("layeredNotes" in patch && patch.layeredNotes === undefined) payload.layeredNotes = del;
  return payload;
}
