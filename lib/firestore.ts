"use client";

import {
  addDoc,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryConstraint
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { trackRead, trackWrite } from "@/lib/usage";
import type { PublicCatalog } from "@/lib/templates/schema";
import type {
  AiInsight,
  AiJob,
  Annotation,
  ClassLog,
  Checkpoint,
  Course,
  DailySchedule,
  DayTemplate,
  FileRef,
  Goal,
  GoogleCalendarConnection,
  NewAnnotation,
  NewCheckpoint,
  NewClassLog,
  NewCourse,
  NewDayTemplate,
  NewFileRef,
  NewGoal,
  NewPaper,
  NewPaperGroup,
  NewPaperNote,
  NewRecurringTaskTemplate,
  NewRevisionItem,
  NewTask,
  NewTerm,
  NewTopic,
  Paper,
  PaperGroup,
  PaperNote,
  PomodoroSession,
  ProposedSlot,
  RecurringTaskTemplate,
  RevisionItem,
  ScheduleSlot,
  Task,
  Term,
  Tier,
  Topic,
  UserProfile,
  UserSettings,
  WeeklyReview
} from "@/types";

const now = () => new Date().toISOString();

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, cleanValue(item)])
  );
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cleanValue(item));
  if (value && typeof value === "object" && value.constructor === Object) {
    return withoutUndefined(value as Record<string, unknown>);
  }
  return value;
}

export function userCollection(uid: string, name: string) {
  if (!db) throw new Error("Firebase is not configured.");
  return collection(db, "users", uid, name);
}

/** A collection at the database root, not scoped under a user — e.g. `tiers`, which is shared across every account. */
export function topLevelCollection(name: string) {
  if (!db) throw new Error("Firebase is not configured.");
  return collection(db, name);
}

/** A collection nested under one course, e.g. users/{uid}/courses/{courseId}/checkpoints. */
export function courseSubcollection(uid: string, courseId: string, name: string) {
  if (!db) throw new Error("Firebase is not configured.");
  return collection(db, "users", uid, "courses", courseId, name);
}

export function paperSubcollection(uid: string, paperId: string, name: string) {
  if (!db) throw new Error("Firebase is not configured.");
  return collection(db, "users", uid, "papers", paperId, name);
}

export function subscribeCollection<T extends { id: string }>(
  uid: string,
  name: string,
  callback: (items: T[]) => void,
  constraints: QueryConstraint[] = [orderBy("createdAt", "desc")]
) {
  if (!db) {
    callback([]);
    return () => undefined;
  }
  const q = query(userCollection(uid, name), ...constraints);
  return onSnapshot(q, (snapshot) => {
    trackRead(snapshot.size);
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as T));
  });
}

export function subscribeDoc<T extends { id: string }>(uid: string, name: string, id: string, callback: (item: T | null) => void) {
  if (!db) {
    callback(null);
    return () => undefined;
  }
  return onSnapshot(doc(userCollection(uid, name), id), (snapshot) => {
    trackRead(1);
    callback(snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as T) : null);
  });
}

export async function fetchCollection<T extends { id: string }>(
  uid: string,
  name: string,
  constraints: QueryConstraint[] = [orderBy("createdAt", "desc")]
): Promise<T[]> {
  if (!db) return [];
  const snapshot = await getDocs(query(userCollection(uid, name), ...constraints));
  trackRead(snapshot.size);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as T);
}

/** The `users/{uid}` root doc itself (profile + tierId) — distinct from the subcollections everything else lives in. */
export function subscribeUserProfile(uid: string, callback: (profile: UserProfile | null) => void) {
  if (!db) {
    callback(null);
    return () => undefined;
  }
  return onSnapshot(doc(db, "users", uid), (snapshot) => {
    trackRead(1);
    callback(snapshot.exists() ? (snapshot.data() as UserProfile) : null);
  });
}

/**
 * Tiers are few and admin-managed, so subscribing to the whole collection is
 * cheap and simpler than a doc-per-user lookup. Read-only from the client by
 * design — creating, editing, or deleting a tier requires the Admin SDK (see
 * scripts/manage-tiers.mjs today; the admin panel's API routes in Phase 4.5).
 */
/** One-off read of `publicCatalog/current` (plan §7.4) — every published admin template + pack defaults + hidden built-ins, in a single document read. Callers (hooks/use-template-catalog.ts) cache this in memory for the session rather than re-fetching. */
export async function fetchPublicCatalog(): Promise<PublicCatalog | null> {
  if (!db) return null;
  const snapshot = await getDoc(doc(db, "publicCatalog", "current"));
  trackRead(1);
  return snapshot.exists() ? (snapshot.data() as PublicCatalog) : null;
}

export function subscribeTiers(callback: (tiers: Tier[]) => void) {
  if (!db) {
    callback([]);
    return () => undefined;
  }
  return onSnapshot(topLevelCollection("tiers"), (snapshot) => {
    trackRead(snapshot.size);
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Tier));
  });
}

export async function upsertUser(uid: string, profile: { displayName: string; email: string; photoURL?: string }) {
  if (!db) return;
  const ref = doc(db, "users", uid);
  const existing = await getDoc(ref);
  trackRead(1);
  trackWrite();
  await setDoc(
    ref,
    withoutUndefined({
      uid,
      ...profile,
      createdAt: existing.exists() ? existing.data().createdAt : now(),
      updatedAt: now()
    }),
    { merge: true }
  );
}

export async function createTask(uid: string, task: NewTask): Promise<string> {
  const createdAt = now();
  trackWrite();
  const ref = await addDoc(userCollection(uid, "tasks"), withoutUndefined({ ...task, createdAt, updatedAt: createdAt }));
  return ref.id;
}

/** Creates every task in one batch (plan §6.3 — "Add from checklist" applies a whole task pack in one write). */
export async function createTasksBatch(uid: string, tasks: NewTask[]) {
  if (!db || tasks.length === 0) return;
  const batch = writeBatch(db);
  const createdAt = now();
  for (const task of tasks) {
    batch.set(doc(userCollection(uid, "tasks")), withoutUndefined({ ...task, createdAt, updatedAt: createdAt }));
  }
  trackWrite(tasks.length);
  await batch.commit();
}

export async function updateTask(uid: string, id: string, patch: Partial<Task>) {
  const payload: Record<string, unknown> = withoutUndefined({ ...patch, updatedAt: now() });
  if ("completedAt" in patch && patch.completedAt === undefined) payload.completedAt = deleteField();
  trackWrite();
  await updateDoc(doc(userCollection(uid, "tasks"), id), payload);
}

export async function deleteTask(uid: string, id: string) {
  trackWrite();
  await deleteDoc(doc(userCollection(uid, "tasks"), id));
}

export async function savePomodoro(uid: string, session: Omit<PomodoroSession, "id">) {
  trackWrite();
  await addDoc(userCollection(uid, "pomodoroSessions"), withoutUndefined({ ...session }));
}

/**
 * Writes fields onto the merged `days/{date}` document. Pass dot-path keys
 * (e.g. `"review.focusRating"`, `"session.startedAt"`) to update a nested
 * field without clobbering its siblings — Firestore's `merge: true` treats a
 * dotted top-level key as a field path, and `setDoc` creates the doc if it
 * doesn't exist yet, so callers never need to check existence first.
 */
export async function saveDayFields(uid: string, date: string, fields: Record<string, unknown>) {
  trackWrite();
  await setDoc(doc(userCollection(uid, "days"), date), withoutUndefined({ date, updatedAt: now(), ...fields }), { merge: true });
}

export async function saveWeeklyReview(uid: string, review: Omit<WeeklyReview, "id" | "updatedAt">) {
  trackWrite();
  await setDoc(doc(userCollection(uid, "weeklyReviews"), review.weekStart), withoutUndefined({ ...review, updatedAt: now() }), {
    merge: true
  });
}

export async function createDayTemplate(uid: string, template: NewDayTemplate): Promise<string> {
  const createdAt = now();
  trackWrite();
  const ref = await addDoc(userCollection(uid, "dayTemplates"), withoutUndefined({ ...template, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updateDayTemplate(uid: string, id: string, patch: Partial<DayTemplate>) {
  trackWrite();
  await updateDoc(doc(userCollection(uid, "dayTemplates"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function deleteDayTemplate(uid: string, id: string) {
  trackWrite();
  await deleteDoc(doc(userCollection(uid, "dayTemplates"), id));
}

/** Marks `id` as the default template and unsets the flag on every other template, in one batch. */
export async function setDefaultTemplate(uid: string, templates: DayTemplate[], id: string) {
  if (!db) return;
  const batch = writeBatch(db);
  let updates = 0;
  for (const template of templates) {
    if (template.id === id && template.isDefault) continue;
    if (template.id !== id && !template.isDefault) continue;
    batch.update(doc(userCollection(uid, "dayTemplates"), template.id), { isDefault: template.id === id, updatedAt: now() });
    updates += 1;
  }
  if (updates === 0) return;
  trackWrite(updates);
  await batch.commit();
}

export async function duplicateDayTemplate(uid: string, template: DayTemplate) {
  await createDayTemplate(uid, {
    name: `${template.name} copy`,
    description: template.description,
    isDefault: false,
    slots: template.slots.map((slot) => ({ ...slot, id: crypto.randomUUID() }))
  });
}

export async function saveDailySchedule(
  uid: string,
  schedule: Omit<DailySchedule, "id" | "createdAt" | "updatedAt"> & { createdAt?: string }
) {
  const ref = doc(userCollection(uid, "dailySchedules"), schedule.dateKey);
  const existing = await getDoc(ref);
  trackRead(1);
  trackWrite();
  const updatedAt = now();
  await setDoc(
    ref,
    withoutUndefined({
      ...schedule,
      createdAt: existing.exists() ? existing.data().createdAt : schedule.createdAt ?? now(),
      updatedAt
    }),
    { merge: true }
  );
  return { updatedAt };
}

export async function createTerm(uid: string, term: NewTerm) {
  const createdAt = now();
  trackWrite();
  await addDoc(userCollection(uid, "terms"), withoutUndefined({ ...term, createdAt, updatedAt: createdAt }));
}

export async function updateTerm(uid: string, id: string, patch: Partial<Term>) {
  trackWrite();
  await updateDoc(doc(userCollection(uid, "terms"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function deleteTerm(uid: string, id: string) {
  trackWrite();
  await deleteDoc(doc(userCollection(uid, "terms"), id));
}

export async function createGoal(uid: string, goal: NewGoal) {
  const createdAt = now();
  trackWrite();
  await addDoc(userCollection(uid, "goals"), withoutUndefined({ ...goal, createdAt, updatedAt: createdAt }));
}

export async function updateGoal(uid: string, id: string, patch: Partial<Goal>) {
  trackWrite();
  await updateDoc(doc(userCollection(uid, "goals"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function deleteGoal(uid: string, id: string) {
  trackWrite();
  await deleteDoc(doc(userCollection(uid, "goals"), id));
}

export async function createRecurringTaskTemplate(uid: string, template: NewRecurringTaskTemplate): Promise<string> {
  const createdAt = now();
  trackWrite();
  const ref = await addDoc(userCollection(uid, "recurringTaskTemplates"), withoutUndefined({ ...template, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updateRecurringTaskTemplate(uid: string, id: string, patch: Partial<RecurringTaskTemplate>) {
  trackWrite();
  await updateDoc(doc(userCollection(uid, "recurringTaskTemplates"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

/**
 * `setDoc` at a caller-chosen id instead of `addDoc`'s random one — used only for the one
 * auto-managed revision template per course (`lib/recurring-tasks.ts`'s `revisionTemplateId`), so
 * that two overlapping "create" writes for the same course (two racing "Save" clicks) land on the
 * same document instead of producing duplicates.
 */
export async function setRecurringTaskTemplate(uid: string, id: string, template: NewRecurringTaskTemplate) {
  const createdAt = now();
  trackWrite();
  await setDoc(doc(userCollection(uid, "recurringTaskTemplates"), id), withoutUndefined({ ...template, createdAt, updatedAt: createdAt }));
}

/**
 * Deleting a template also removes the task instances it already generated, so long as they're
 * still open — a deleted series shouldn't leave zombie tasks in the list pointing at a template
 * that no longer exists. Instances the user already completed are left alone; they're history.
 */
export async function deleteRecurringTaskTemplate(uid: string, id: string) {
  if (!db) return;
  // Equality-only filter (no composite index needed) — "done" ones are filtered out client-side
  // before deleting, same trick used below in deleteCourse.
  const instances = await getDocs(query(userCollection(uid, "tasks"), where("seriesId", "==", id)));
  trackRead(instances.size);
  const openInstances = instances.docs.filter((item) => item.data().status !== "done");
  const batch = writeBatch(db);
  openInstances.forEach((item) => batch.delete(item.ref));
  batch.delete(doc(userCollection(uid, "recurringTaskTemplates"), id));
  trackWrite(openInstances.length + 1);
  await batch.commit();
}

/**
 * Appends one Accept-ed rollup slot into a date's DailySchedule, creating the
 * schedule from the default (or break) template first if that date has no
 * schedule yet — the same "ensure a schedule exists" logic Start Day already
 * uses (components/workday-session-provider.tsx), duplicated here in
 * miniature since a proposed slot can target a day the user hasn't started yet.
 */
export async function appendProposedSlotToSchedule(
  uid: string,
  dateKey: string,
  proposed: ProposedSlot,
  fallbackTemplateSlots: ScheduleSlot[]
) {
  const ref = doc(userCollection(uid, "dailySchedules"), dateKey);
  const existing = await getDoc(ref);
  trackRead(1);
  const baseSlots = existing.exists() ? ((existing.data().slots as ScheduleSlot[] | undefined) ?? []) : fallbackTemplateSlots;
  const newSlot: ScheduleSlot = {
    id: crypto.randomUUID(),
    title: proposed.title,
    type: proposed.type,
    startTime: proposed.startTime,
    endTime: proposed.endTime,
    status: "upcoming"
  };
  trackWrite();
  await setDoc(
    ref,
    withoutUndefined({
      dateKey,
      slots: [...baseSlots, newSlot],
      createdAt: existing.exists() ? existing.data().createdAt : now(),
      updatedAt: now()
    }),
    { merge: true }
  );
}

export async function createCourse(uid: string, course: NewCourse): Promise<string> {
  const createdAt = now();
  trackWrite();
  const ref = await addDoc(userCollection(uid, "courses"), withoutUndefined({ ...course, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updateCourse(uid: string, id: string, patch: Partial<Course>) {
  trackWrite();
  await updateDoc(doc(userCollection(uid, "courses"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

/**
 * Deletes a course and cascades to its nested checkpoints/classLogs (topics are kept — they
 * outlive the course) plus its recurringTaskTemplates (plan `FocusOS-v2-Connected-Flow-Plan.md`
 * §7's "flip templates off with their course" — those aren't a subcollection, so they need their
 * own query, not just a subcollection delete), plus any still-open task instances those templates
 * already generated — same "don't leave zombie tasks behind" rule as deleteRecurringTaskTemplate.
 * Ordinary hand-created tasks that merely reference the course (no seriesId) are left alone.
 */
export async function deleteCourse(uid: string, id: string) {
  if (!db) return;
  const [checkpoints, classLogs, templates, courseTasks] = await Promise.all([
    getDocs(courseSubcollection(uid, id, "checkpoints")),
    getDocs(courseSubcollection(uid, id, "classLogs")),
    getDocs(query(userCollection(uid, "recurringTaskTemplates"), where("courseId", "==", id))),
    getDocs(query(userCollection(uid, "tasks"), where("courseId", "==", id)))
  ]);
  const openInstances = courseTasks.docs.filter((item) => item.data().seriesId && item.data().status !== "done");
  trackRead(checkpoints.size + classLogs.size + templates.size + courseTasks.size);
  const batch = writeBatch(db);
  checkpoints.docs.forEach((item) => batch.delete(item.ref));
  classLogs.docs.forEach((item) => batch.delete(item.ref));
  templates.docs.forEach((item) => batch.delete(item.ref));
  openInstances.forEach((item) => batch.delete(item.ref));
  batch.delete(doc(userCollection(uid, "courses"), id));
  trackWrite(checkpoints.size + classLogs.size + templates.size + openInstances.length + 1);
  await batch.commit();
}

export function subscribeCourseCheckpoints(uid: string, courseId: string, callback: (items: Checkpoint[]) => void) {
  if (!db) {
    callback([]);
    return () => undefined;
  }
  const q = query(courseSubcollection(uid, courseId, "checkpoints"), orderBy("dueAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    trackRead(snapshot.size);
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Checkpoint));
  });
}

export async function fetchCourseCheckpoints(uid: string, courseId: string): Promise<Checkpoint[]> {
  if (!db) return [];
  const snapshot = await getDocs(query(courseSubcollection(uid, courseId, "checkpoints"), orderBy("dueAt", "asc")));
  trackRead(snapshot.size);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Checkpoint);
}

export async function createCheckpoint(uid: string, courseId: string, checkpoint: NewCheckpoint) {
  const createdAt = now();
  trackWrite();
  await addDoc(courseSubcollection(uid, courseId, "checkpoints"), withoutUndefined({ ...checkpoint, createdAt, updatedAt: createdAt }));
}

export async function updateCheckpoint(uid: string, courseId: string, id: string, patch: Partial<Checkpoint>) {
  trackWrite();
  await updateDoc(doc(courseSubcollection(uid, courseId, "checkpoints"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function deleteCheckpoint(uid: string, courseId: string, id: string) {
  trackWrite();
  await deleteDoc(doc(courseSubcollection(uid, courseId, "checkpoints"), id));
}

export function subscribeCourseClassLogs(uid: string, courseId: string, callback: (items: ClassLog[]) => void) {
  if (!db) {
    callback([]);
    return () => undefined;
  }
  const q = query(courseSubcollection(uid, courseId, "classLogs"), orderBy("date", "desc"));
  return onSnapshot(q, (snapshot) => {
    trackRead(snapshot.size);
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as ClassLog));
  });
}

/** Class logs are keyed by date, one per course per day — re-logging the same day overwrites it. */
export async function saveClassLog(uid: string, courseId: string, log: NewClassLog) {
  trackWrite();
  await setDoc(doc(courseSubcollection(uid, courseId, "classLogs"), log.date), withoutUndefined({ ...log, updatedAt: now() }), {
    merge: true
  });
}

export async function fetchCourseClassLogs(uid: string, courseId: string): Promise<ClassLog[]> {
  if (!db) return [];
  const snapshot = await getDocs(query(courseSubcollection(uid, courseId, "classLogs"), orderBy("date", "desc")));
  trackRead(snapshot.size);
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as ClassLog);
}

export async function fetchCourseTopics(uid: string, courseId: string): Promise<Topic[]> {
  return fetchCollection<Topic>(uid, "topics", [where("courseId", "==", courseId)]);
}

export function subscribeCourseTopics(uid: string, courseId: string, callback: (items: Topic[]) => void) {
  return subscribeCollection<Topic>(uid, "topics", callback, [where("courseId", "==", courseId)]);
}

export async function createTopic(uid: string, topic: NewTopic): Promise<string> {
  const createdAt = now();
  trackWrite();
  const ref = await addDoc(userCollection(uid, "topics"), withoutUndefined({ ...topic, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updateTopic(uid: string, id: string, patch: Partial<Topic>) {
  trackWrite();
  await updateDoc(doc(userCollection(uid, "topics"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function createRevisionItem(uid: string, item: NewRevisionItem): Promise<string> {
  const createdAt = now();
  trackWrite();
  const ref = await addDoc(userCollection(uid, "revisionItems"), withoutUndefined({ ...item, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updateRevisionItem(uid: string, id: string, patch: Partial<RevisionItem>) {
  const payload: Record<string, unknown> = withoutUndefined({ ...patch, updatedAt: now() });
  if ("retiredAt" in patch && patch.retiredAt === undefined) payload.retiredAt = deleteField();
  trackWrite();
  await updateDoc(doc(userCollection(uid, "revisionItems"), id), payload);
}

/** Every due, non-suspended revision item — bounded by the caller's daily cap after fetch, per the review queue design. */
export function subscribeDueRevisionItems(uid: string, todayKey: string, callback: (items: RevisionItem[]) => void) {
  return subscribeCollection<RevisionItem>(uid, "revisionItems", callback, [
    where("suspended", "==", false),
    where("dueDate", "<=", todayKey),
    orderBy("dueDate", "asc")
  ]);
}

export async function createPaper(uid: string, paper: NewPaper) {
  const createdAt = now();
  trackWrite();
  await addDoc(userCollection(uid, "papers"), withoutUndefined({ progress: 0, groupIds: [], ...paper, createdAt, updatedAt: createdAt }));
}

export async function updatePaper(uid: string, id: string, patch: Partial<Paper>) {
  const payload: Record<string, unknown> = withoutUndefined({ ...patch, updatedAt: now() });
  if ("readAt" in patch && patch.readAt === undefined) payload.readAt = deleteField();
  if ("fileId" in patch && patch.fileId === undefined) payload.fileId = deleteField();
  // Replacing or removing the attached PDF invalidates any cached Anthropic
  // file reference and the layered notes generated from it — a stale summary
  // of a since-replaced PDF would be actively misleading, not just outdated.
  if ("fileId" in patch) {
    payload.anthropicFileId = deleteField();
    payload.layeredNotes = deleteField();
  }
  if ("anthropicFileId" in patch && patch.anthropicFileId === undefined) payload.anthropicFileId = deleteField();
  if ("layeredNotes" in patch && patch.layeredNotes === undefined) payload.layeredNotes = deleteField();
  trackWrite();
  await updateDoc(doc(userCollection(uid, "papers"), id), payload);
}

/** Deletes a paper's notes/annotations subcollections along with the paper itself. Does not touch an attached file — see lib/files-client.ts's deletePaperFile, which needs a server route since Blob deletion requires the write token. */
export async function deletePaper(uid: string, id: string) {
  if (!db) return;
  const [notes, annotations] = await Promise.all([getDocs(paperSubcollection(uid, id, "notes")), getDocs(paperSubcollection(uid, id, "annotations"))]);
  trackRead(notes.size + annotations.size);
  const batch = writeBatch(db);
  notes.docs.forEach((item) => batch.delete(item.ref));
  annotations.docs.forEach((item) => batch.delete(item.ref));
  batch.delete(doc(userCollection(uid, "papers"), id));
  trackWrite(notes.size + annotations.size + 1);
  await batch.commit();
}

export function subscribePaperNotes(uid: string, paperId: string, callback: (notes: PaperNote[]) => void) {
  if (!db) {
    callback([]);
    return () => undefined;
  }
  const q = query(paperSubcollection(uid, paperId, "notes"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snapshot) => {
    trackRead(snapshot.size);
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as PaperNote));
  });
}

export async function createPaperNote(uid: string, paperId: string, note: NewPaperNote) {
  trackWrite();
  await addDoc(paperSubcollection(uid, paperId, "notes"), withoutUndefined({ ...note, createdAt: now() }));
}

export async function deletePaperNote(uid: string, paperId: string, noteId: string) {
  trackWrite();
  await deleteDoc(doc(paperSubcollection(uid, paperId, "notes"), noteId));
}

export function subscribeAnnotations(uid: string, paperId: string, callback: (annotations: Annotation[]) => void) {
  if (!db) {
    callback([]);
    return () => undefined;
  }
  const q = query(paperSubcollection(uid, paperId, "annotations"), orderBy("createdAt", "asc"));
  return onSnapshot(q, (snapshot) => {
    trackRead(snapshot.size);
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Annotation));
  });
}

export async function createAnnotation(uid: string, paperId: string, annotation: NewAnnotation) {
  trackWrite();
  await addDoc(paperSubcollection(uid, paperId, "annotations"), withoutUndefined({ ...annotation, createdAt: now() }));
}

/** One batched write for a whole page of AI-matched highlights, rather than N individual addDoc calls. */
export async function createAnnotationsBatch(uid: string, paperId: string, annotations: NewAnnotation[]) {
  if (!db || annotations.length === 0) return;
  const batch = writeBatch(db);
  annotations.forEach((annotation) => {
    batch.set(doc(paperSubcollection(uid, paperId, "annotations")), withoutUndefined({ ...annotation, createdAt: now() }));
  });
  trackWrite(annotations.length);
  await batch.commit();
}

export async function updateAnnotation(uid: string, paperId: string, annotationId: string, patch: Partial<Annotation>) {
  trackWrite();
  await updateDoc(doc(paperSubcollection(uid, paperId, "annotations"), annotationId), withoutUndefined({ ...patch }));
}

export async function deleteAnnotation(uid: string, paperId: string, annotationId: string) {
  trackWrite();
  await deleteDoc(doc(paperSubcollection(uid, paperId, "annotations"), annotationId));
}

export async function createPaperGroup(uid: string, group: NewPaperGroup) {
  const createdAt = now();
  trackWrite();
  const ref = await addDoc(userCollection(uid, "paperGroups"), withoutUndefined({ ...group, createdAt, updatedAt: createdAt }));
  return ref.id;
}

export async function updatePaperGroup(uid: string, id: string, patch: Partial<PaperGroup>) {
  trackWrite();
  await updateDoc(doc(userCollection(uid, "paperGroups"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function deletePaperGroup(uid: string, id: string) {
  trackWrite();
  await deleteDoc(doc(userCollection(uid, "paperGroups"), id));
}

export async function createFileRef(uid: string, file: NewFileRef): Promise<string> {
  trackWrite();
  const ref = await addDoc(userCollection(uid, "files"), withoutUndefined({ ...file }));
  return ref.id;
}

export async function deleteFileRef(uid: string, id: string) {
  trackWrite();
  await deleteDoc(doc(userCollection(uid, "files"), id));
}

const BLOB_USAGE_DOC_ID = "blobUsage";

/** Cumulative account-wide blob byte total, separate from the monthly read/write counters — checked against the 800 MB soft cap. */
export async function adjustBlobUsage(uid: string, deltaBytes: number) {
  if (!db) return;
  trackWrite();
  await setDoc(doc(userCollection(uid, "meta"), BLOB_USAGE_DOC_ID), { totalBytes: increment(deltaBytes) }, { merge: true });
}

export function subscribeBlobUsage(uid: string, callback: (totalBytes: number) => void) {
  return subscribeDoc<{ id: string; totalBytes?: number }>(uid, "meta", BLOB_USAGE_DOC_ID, (item) => callback(item?.totalBytes ?? 0));
}

export async function startWorkdaySession(uid: string, date: string) {
  await saveDayFields(uid, date, { "session.startedAt": now(), "session.hydrationCount": 0, "session.breaksTaken": 0 });
}

export async function endWorkdaySession(uid: string, date: string) {
  await saveDayFields(uid, date, { "session.endedAt": now() });
}

/** F11 (plan §11.2) — the 10-second "Undo" toast's action: clears `session.endedAt` so the day reads active again, without touching whatever the evening rollup already generated. */
export async function undoEndWorkdaySession(uid: string, date: string) {
  await saveDayFields(uid, date, { "session.endedAt": deleteField() });
}

export async function recordHydration(uid: string, date: string, hydrationCount: number) {
  await saveDayFields(uid, date, { "session.hydrationCount": hydrationCount, "session.lastHydrationAt": now() });
}

export async function recordBreak(uid: string, date: string, breaksTaken: number) {
  await saveDayFields(uid, date, { "session.breaksTaken": breaksTaken, "session.lastBreakPromptAt": now() });
}

export async function saveAiInsight(uid: string, insight: Omit<AiInsight, "id">) {
  trackWrite();
  await setDoc(doc(userCollection(uid, "aiInsights"), insight.date), withoutUndefined({ ...insight }), { merge: true });
}

const SETTINGS_DOC_ID = "settings";

export async function saveUserSettings(uid: string, patch: Partial<Omit<UserSettings, "updatedAt">>) {
  const payload: Record<string, unknown> = withoutUndefined({ ...patch, updatedAt: now() });
  if ("breakTemplateId" in patch && patch.breakTemplateId === undefined) payload.breakTemplateId = deleteField();
  // "Reset to pack defaults" (plan §9.1's custom-selection model) clears the override by passing
  // `enabledModules: undefined` — under merge:true that's normally a no-op (the key is just
  // omitted), the same bug class `setPackDefaultTemplate` had to work around in U2.
  if ("enabledModules" in patch && patch.enabledModules === undefined) payload.enabledModules = deleteField();
  trackWrite();
  await setDoc(doc(userCollection(uid, "meta"), SETTINGS_DOC_ID), payload, { merge: true });
}

export function subscribeUserSettings(uid: string, callback: (settings: UserSettings | null) => void) {
  return subscribeDoc<UserSettings & { id: string }>(uid, "meta", SETTINGS_DOC_ID, callback);
}

const GOOGLE_CALENDAR_CONNECTION_DOC_ID = "googleCalendar";

/** plan/FocusOS-v2-Google-Calendar-Sync-Plan.md §4.2 — the non-secret connection-status doc, at
 * users/{uid}/integrations/googleCalendar. The refresh token itself is never reachable through this
 * file or any client-readable path — see lib/google-calendar-admin.ts. */
export function subscribeGoogleCalendarConnection(uid: string, callback: (connection: (GoogleCalendarConnection & { id: string }) | null) => void) {
  return subscribeDoc<GoogleCalendarConnection & { id: string }>(uid, "integrations", GOOGLE_CALENDAR_CONNECTION_DOC_ID, callback);
}

/** Client-settable preferences only — `connected`/`googleAccountEmail`/`focusOsCalendarId` are
 * written exclusively by the server-side connect/disconnect routes (Admin SDK), never through here. */
export async function saveGoogleCalendarConnectionPrefs(
  uid: string,
  patch: Partial<Pick<GoogleCalendarConnection, "pushEnabled" | "importCalendarIds" | "pullEnabled">>
) {
  trackWrite();
  await setDoc(doc(userCollection(uid, "integrations"), GOOGLE_CALENDAR_CONNECTION_DOC_ID), withoutUndefined({ ...patch, updatedAt: now() }), {
    merge: true
  });
}

export async function resolveAlert(uid: string, id: string) {
  trackWrite();
  await setDoc(doc(userCollection(uid, "alerts"), id), { resolvedAt: now(), updatedAt: now() }, { merge: true });
}

export function subscribeAiJob(uid: string, id: string, callback: (job: AiJob | null) => void) {
  return subscribeDoc<AiJob>(uid, "aiJobs", id, callback);
}

export const q = { where, orderBy };

export function mapDoc<T>(id: string, data: DocumentData) {
  return { id, ...data } as T;
}
