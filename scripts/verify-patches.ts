#!/usr/bin/env tsx
/**
 * plan/19 §5.1 — the shared write rules (`lib/patches.ts`) that both the client (`lib/firestore.ts`)
 * and the MCP server (`lib/admin-writes.ts`) build their payloads from. The expectations below were
 * written from what `updateTask`/`updatePaper` did before the builders were extracted, so a green run
 * means the move changed nothing for the app.
 *
 * Pure: no Firestore. The delete sentinel is a stand-in symbol, which is exactly how the two SDKs use
 * the builders (`deleteField()` on the client, `FieldValue.delete()` on the server).
 */
import { expandDotPaths, paperPatch, taskPatch, withoutUndefined } from "../lib/patches";
import { dropPatch, queuePatch, restorePatch, shelvePatch, unqueuePatch } from "../lib/papers";
import type { Paper } from "../types";

const DEL = Symbol("delete");
const NOW = "2026-11-27T10:00:00.000Z";
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail, (_k, v) => (v === DEL ? "<DEL>" : v))}`);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join() !== kb.join()) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function expect(label: string, actual: unknown, wanted: unknown) {
  check(label, same(actual, wanted), { actual, wanted });
}

// ---- withoutUndefined / expandDotPaths ----
expect("withoutUndefined drops undefined, keeps null and nested", withoutUndefined({ a: 1, b: undefined, c: null, d: { e: undefined, f: 2 }, g: [{ h: undefined, i: 3 }] }), {
  a: 1,
  c: null,
  d: { f: 2 },
  g: [{ i: 3 }]
});
expect("expandDotPaths nests dotted keys", expandDotPaths({ "session.startedAt": "x", "session.hydrationCount": 0, date: "d" }), {
  session: { startedAt: "x", hydrationCount: 0 },
  date: "d"
});

// ---- taskPatch: the updateTask rules ----
expect("task: a plain field", taskPatch({ title: "Read" }, DEL, NOW), { title: "Read", updatedAt: NOW });
expect("task: completedAt undefined clears it", taskPatch({ status: "todo", completedAt: undefined }, DEL, NOW), { status: "todo", completedAt: DEL, updatedAt: NOW });
expect("task: weeklyTargetDay undefined clears it", taskPatch({ weeklyTargetDay: undefined }, DEL, NOW), { weeklyTargetDay: DEL, updatedAt: NOW });
// Every other optional field passed as undefined is simply omitted — unchanged from before.
expect("task: other undefined fields are omitted, not cleared", taskPatch({ description: undefined, dueDate: undefined }, DEL, NOW), { updatedAt: NOW });
expect("task: nested undefined is stripped", taskPatch({ fixedTime: { startTime: "14:00", endTime: "15:00", location: undefined } }, DEL, NOW), {
  fixedTime: { startTime: "14:00", endTime: "15:00" },
  updatedAt: NOW
});
expect("task: a real completedAt is written", taskPatch({ status: "done", completedAt: NOW, previousStatus: "todo" }, DEL, NOW), {
  status: "done",
  completedAt: NOW,
  previousStatus: "todo",
  updatedAt: NOW
});

// ---- paperPatch: the updatePaper rules ----
expect("paper: fileId replaced also clears the cached file and layered notes", paperPatch({ fileId: "f2" }, DEL, NOW), {
  fileId: "f2",
  anthropicFileId: DEL,
  layeredNotes: DEL,
  updatedAt: NOW
});
expect("paper: fileId removed clears all three", paperPatch({ fileId: undefined }, DEL, NOW), { fileId: DEL, anthropicFileId: DEL, layeredNotes: DEL, updatedAt: NOW });
// The quirk: a fileId in the patch wins over an anthropicFileId passed alongside it.
expect("paper: fileId wins over an anthropicFileId passed with it", paperPatch({ fileId: "f3", anthropicFileId: "a1" }, DEL, NOW), {
  fileId: "f3",
  anthropicFileId: DEL,
  layeredNotes: DEL,
  updatedAt: NOW
});
expect("paper: anthropicFileId alone can be set", paperPatch({ anthropicFileId: "a1" }, DEL, NOW), { anthropicFileId: "a1", updatedAt: NOW });
expect("paper: anthropicFileId undefined clears it", paperPatch({ anthropicFileId: undefined }, DEL, NOW), { anthropicFileId: DEL, updatedAt: NOW });
expect("paper: layeredNotes undefined clears it", paperPatch({ layeredNotes: undefined }, DEL, NOW), { layeredNotes: DEL, updatedAt: NOW });
for (const key of ["readAt", "weeklyTargetDay", "queuedAt", "shelvedUntil", "droppedAt", "inbox"] as const) {
  expect(`paper: ${key} undefined clears it`, paperPatch({ [key]: undefined } as Partial<Paper>, DEL, NOW), { [key]: DEL, updatedAt: NOW });
}
expect("paper: shelvedUntil null is a real value, kept", paperPatch({ shelvedUntil: null }, DEL, NOW), { shelvedUntil: null, updatedAt: NOW });
expect("paper: other undefined fields are omitted", paperPatch({ venue: undefined, title: "T" }, DEL, NOW), { title: "T", updatedAt: NOW });

// ---- the lib/papers.ts exit patches, through the builder ----
const base: Paper = {
  id: "p1",
  title: "A paper",
  authors: [],
  status: "inbox",
  priority: "medium",
  tags: [],
  progress: 0,
  groupIds: [],
  inbox: true,
  createdAt: NOW,
  updatedAt: NOW
};
{
  const out = paperPatch(queuePatch(base, NOW), DEL, NOW);
  check("queue: sets queuedAt and clears inbox", out.queuedAt === NOW && out.inbox === DEL, out);
  check("queue: recomputes the status cache", typeof out.status === "string" && out.status !== "inbox", out);
}
{
  const queued: Paper = { ...base, inbox: undefined, queuedAt: NOW, status: "to_read" };
  const out = paperPatch(unqueuePatch(queued), DEL, NOW);
  check("unqueue: clears queuedAt", out.queuedAt === DEL, out);
}
{
  const out = paperPatch(shelvePatch(base, "2026-12-27"), DEL, NOW);
  check("shelve: sets the date, clears queue and inbox", out.shelvedUntil === "2026-12-27" && out.queuedAt === DEL && out.inbox === DEL && out.status === "shelved", out);
}
{
  const out = paperPatch(dropPatch(base, NOW), DEL, NOW);
  check("drop: sets droppedAt, clears queue and inbox", out.droppedAt === NOW && out.queuedAt === DEL && out.inbox === DEL && out.status === "dropped", out);
}
{
  const dropped: Paper = { ...base, inbox: undefined, droppedAt: NOW, status: "dropped" };
  const out = paperPatch(restorePatch(dropped), DEL, NOW);
  check("restore: clears droppedAt and leaves dropped", out.droppedAt === DEL && out.status !== "dropped", out);
}

if (failures.length > 0) {
  console.error(`verify-patches: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("verify-patches: all checks passed");
