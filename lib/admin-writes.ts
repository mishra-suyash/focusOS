/**
 * plan/19 §5.1 — the Admin SDK writers the MCP server uses, built from the same pure builders as the
 * client's `lib/firestore.ts` (`lib/patches.ts`), so a write from Claude keeps every rule a write from
 * the app keeps: `undefined` clears, a new `fileId` invalidates the paper's cached file and layered
 * notes, `createdAt` survives, `updatedAt` is always fresh (the day autosave's two-tab guard reads it).
 *
 * Every function takes `uid` and builds its path from it. Nothing here reads a uid from anywhere else.
 */
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { expandDotPaths, paperPatch, taskPatch, withoutUndefined } from "@/lib/patches";
import type { ReleasedSlot } from "@/lib/weekplan";
import type { Checkpoint, DailySchedule, Goal, NewCheckpoint, NewClassLog, NewGoal, NewPaper, NewPaperNote, NewTask, Paper, Task } from "@/types";

const now = () => new Date().toISOString();
const DELETE = () => FieldValue.delete();

export function userRef(uid: string) {
  return adminDb().collection("users").doc(uid);
}

export function userCol(uid: string, name: string) {
  return userRef(uid).collection(name);
}

/** Keys set to `null` by a caller that means "clear this field" (the MCP tools' convention), as deletes. */
function clears(keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, DELETE()]));
}

export async function createTask(uid: string, task: NewTask): Promise<string> {
  const createdAt = now();
  const ref = await userCol(uid, "tasks").add(withoutUndefined({ ...task, createdAt, updatedAt: createdAt }));
  return ref.id;
}

/** `updateTask`'s rules, plus `cleared`: optional fields the caller explicitly removes. */
export async function updateTask(uid: string, id: string, patch: Partial<Task>, cleared: string[] = []) {
  await userCol(uid, "tasks").doc(id).update({ ...taskPatch(patch, DELETE(), now()), ...clears(cleared) });
}

/** `createPaper`'s defaults: progress 0, no groups. */
export async function createPaper(uid: string, paper: NewPaper): Promise<string> {
  const createdAt = now();
  const ref = await userCol(uid, "papers").add(withoutUndefined({ progress: 0, groupIds: [], ...paper, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updatePaper(uid: string, id: string, patch: Partial<Paper>, cleared: string[] = []) {
  await userCol(uid, "papers").doc(id).update({ ...paperPatch(patch, DELETE(), now()), ...clears(cleared) });
}

export async function createPaperNote(uid: string, paperId: string, note: NewPaperNote): Promise<string> {
  const ref = await userCol(uid, "papers").doc(paperId).collection("notes").add(withoutUndefined({ ...note, createdAt: now() }));
  return ref.id;
}

export async function createCheckpoint(uid: string, courseId: string, checkpoint: NewCheckpoint): Promise<string> {
  const createdAt = now();
  const ref = await userCol(uid, "courses").doc(courseId).collection("checkpoints").add(withoutUndefined({ ...checkpoint, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updateCheckpoint(uid: string, courseId: string, id: string, patch: Partial<Checkpoint>, cleared: string[] = []) {
  await userCol(uid, "courses")
    .doc(courseId)
    .collection("checkpoints")
    .doc(id)
    .update({ ...withoutUndefined({ ...patch, updatedAt: now() }), ...clears(cleared) });
}

/** Class logs are keyed by date, one per course per day — re-logging the same day merges into it, as `saveClassLog` does. */
export async function saveClassLog(uid: string, courseId: string, log: NewClassLog) {
  await userCol(uid, "courses").doc(courseId).collection("classLogs").doc(log.date).set(withoutUndefined({ ...log, updatedAt: now() }), { merge: true });
}

export async function createGoal(uid: string, goal: NewGoal): Promise<string> {
  const createdAt = now();
  const ref = await userCol(uid, "goals").add(withoutUndefined({ ...goal, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updateGoal(uid: string, id: string, patch: Partial<Goal>, cleared: string[] = []) {
  await userCol(uid, "goals").doc(id).update({ ...withoutUndefined({ ...patch, updatedAt: now() }), ...clears(cleared) });
}

/**
 * `saveDayFields` for the Admin SDK, with the same dot-path trap handled: `set(..., {merge: true})`
 * stores `"session.startedAt"` as a literal top-level field name, so an existing doc gets `update`
 * (which parses the path) and a new one gets `set` with the keys expanded into a nested object.
 */
export async function saveDayFields(uid: string, date: string, fields: Record<string, unknown>) {
  const ref = userCol(uid, "days").doc(date);
  const payload = withoutUndefined({ updatedAt: now(), ...fields });
  const existing = await ref.get();
  if (existing.exists) {
    await ref.update(payload);
  } else {
    await ref.set({ date, ...expandDotPaths(payload) }, { merge: true });
  }
}

export const deleteSentinel = DELETE;

/**
 * `saveDailySchedule` for the Admin SDK. Keeps `createdAt`; `updatedAt` is always a fresh stamp, never
 * the old one, so a `/plan/day` tab open on this date sees a remote write it didn't make and raises
 * its conflict instead of autosaving over it (hooks/use-day-autosave.ts).
 */
export async function saveDailySchedule(uid: string, schedule: Pick<DailySchedule, "dateKey" | "slots" | "templateId">): Promise<{ updatedAt: string }> {
  const ref = userCol(uid, "dailySchedules").doc(schedule.dateKey);
  const existing = await ref.get();
  const updatedAt = now();
  await ref.set(
    withoutUndefined({
      ...schedule,
      createdAt: existing.exists ? existing.data()?.createdAt ?? updatedAt : updatedAt,
      updatedAt
    }),
    { merge: true }
  );
  return { updatedAt };
}

/** `removeSittings` (lib/plan-release.ts) for the Admin SDK: every day is re-read first, so a stale copy can't overwrite a newer edit. */
export async function removeSittings(uid: string, released: ReleasedSlot[]): Promise<string[]> {
  const touched: string[] = [];
  for (const dateKey of new Set(released.map((item) => item.dateKey))) {
    const snapshot = await userCol(uid, "dailySchedules").doc(dateKey).get();
    if (!snapshot.exists) continue;
    const schedule = snapshot.data() as DailySchedule;
    const gone = new Set(released.filter((item) => item.dateKey === dateKey).map((item) => item.slot.id));
    await saveDailySchedule(uid, { dateKey, templateId: schedule.templateId, slots: schedule.slots.filter((slot) => !gone.has(slot.id)) });
    touched.push(dateKey);
  }
  return touched;
}

/**
 * `deleteCourse`'s cascade, ported in the same shape (plan/19 §5.1 step 3): checkpoints, class logs,
 * the course's recurring templates, and the still-open task instances those templates generated.
 * Topics are kept; hand-made tasks that merely reference the course are left alone. Not exposed as a
 * tool in v1 (D3) — here so the day deletes are wanted, the rules are already the app's.
 */
export async function deleteCourseCascade(uid: string, id: string) {
  const course = userCol(uid, "courses").doc(id);
  const [checkpoints, classLogs, templates, courseTasks] = await Promise.all([
    course.collection("checkpoints").get(),
    course.collection("classLogs").get(),
    userCol(uid, "recurringTaskTemplates").where("courseId", "==", id).get(),
    userCol(uid, "tasks").where("courseId", "==", id).get()
  ]);
  const openInstances = courseTasks.docs.filter((item) => item.data().seriesId && item.data().status !== "done");
  const batch = adminDb().batch();
  [...checkpoints.docs, ...classLogs.docs, ...templates.docs, ...openInstances].forEach((item) => batch.delete(item.ref));
  batch.delete(course);
  await batch.commit();
}

/** `deletePaper`'s cascade: notes and annotations go with it. The Blob file needs `deletePaperFile` separately. */
export async function deletePaperCascade(uid: string, id: string) {
  const paper = userCol(uid, "papers").doc(id);
  const [notes, annotations] = await Promise.all([paper.collection("notes").get(), paper.collection("annotations").get()]);
  const batch = adminDb().batch();
  [...notes.docs, ...annotations.docs].forEach((item) => batch.delete(item.ref));
  batch.delete(paper);
  await batch.commit();
}

/** plan/19 §5.3 — MCP traffic lands in the same monthly usage document the client's meter flushes to (lib/usage.ts). */
export async function recordUsage(uid: string, reads: number, writes: number) {
  if (reads === 0 && writes === 0) return;
  const month = new Date().toISOString().slice(0, 7);
  await userCol(uid, "usage")
    .doc(month)
    .set({ month, reads: FieldValue.increment(reads), writes: FieldValue.increment(writes) }, { merge: true });
}
