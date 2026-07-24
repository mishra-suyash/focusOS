"use client";

import {
  addDoc,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type QueryConstraint
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type {
  DailyNote,
  DailyPlan,
  DailyReview,
  DailySchedule,
  DayTemplate,
  NewDayTemplate,
  NewTask,
  NewThought,
  PomodoroSession,
  Task,
  Thought,
  ThoughtSelection,
  WeeklyGoal,
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
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as T));
  });
}

export async function upsertUser(uid: string, profile: { displayName: string; email: string; photoURL?: string }) {
  if (!db) return;
  const ref = doc(db, "users", uid);
  const existing = await getDoc(ref);
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

export async function createTask(uid: string, task: NewTask) {
  const createdAt = now();
  await addDoc(userCollection(uid, "tasks"), withoutUndefined({ ...task, createdAt, updatedAt: createdAt }));
}

export async function updateTask(uid: string, id: string, patch: Partial<Task>) {
  const payload: Record<string, unknown> = withoutUndefined({ ...patch, updatedAt: now() });
  if ("completedAt" in patch && patch.completedAt === undefined) payload.completedAt = deleteField();
  await updateDoc(doc(userCollection(uid, "tasks"), id), payload);
}

export async function deleteTask(uid: string, id: string) {
  await deleteDoc(doc(userCollection(uid, "tasks"), id));
}

export async function savePomodoro(uid: string, session: Omit<PomodoroSession, "id">) {
  await addDoc(userCollection(uid, "pomodoroSessions"), withoutUndefined({ ...session }));
}

export async function saveDailyNote(uid: string, date: string, content: string) {
  const ref = doc(userCollection(uid, "dailyNotes"), date);
  const note: Omit<DailyNote, "id"> = { date, content, updatedAt: now() };
  await setDoc(ref, withoutUndefined({ ...note }), { merge: true });
}

export async function saveDailyPlan(uid: string, plan: Omit<DailyPlan, "id" | "updatedAt">) {
  await setDoc(doc(userCollection(uid, "dailyPlans"), plan.date), withoutUndefined({ ...plan, updatedAt: now() }), {
    merge: true
  });
}

export async function saveDailyReview(uid: string, review: Omit<DailyReview, "id" | "updatedAt">) {
  await setDoc(doc(userCollection(uid, "dailyReviews"), review.date), withoutUndefined({ ...review, updatedAt: now() }), {
    merge: true
  });
}

export async function saveWeeklyReview(uid: string, review: Omit<WeeklyReview, "id" | "updatedAt">) {
  await setDoc(doc(userCollection(uid, "weeklyReviews"), review.weekStart), withoutUndefined({ ...review, updatedAt: now() }), {
    merge: true
  });
}

export async function createWeeklyGoal(uid: string, goal: Omit<WeeklyGoal, "id" | "createdAt" | "updatedAt">) {
  const createdAt = now();
  await addDoc(userCollection(uid, "weeklyGoals"), withoutUndefined({ ...goal, createdAt, updatedAt: createdAt }));
}

export async function updateWeeklyGoal(uid: string, id: string, patch: Partial<WeeklyGoal>) {
  await updateDoc(doc(userCollection(uid, "weeklyGoals"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function createDayTemplate(uid: string, template: NewDayTemplate) {
  const createdAt = now();
  await addDoc(userCollection(uid, "dayTemplates"), withoutUndefined({ ...template, createdAt, updatedAt: createdAt }));
}

export async function updateDayTemplate(uid: string, id: string, patch: Partial<DayTemplate>) {
  await updateDoc(doc(userCollection(uid, "dayTemplates"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function deleteDayTemplate(uid: string, id: string) {
  await deleteDoc(doc(userCollection(uid, "dayTemplates"), id));
}

export async function duplicateDayTemplate(uid: string, template: DayTemplate) {
  await createDayTemplate(uid, {
    name: `${template.name} copy`,
    description: template.description,
    slots: template.slots.map((slot) => ({ ...slot, id: crypto.randomUUID() }))
  });
}

export async function saveDailySchedule(
  uid: string,
  schedule: Omit<DailySchedule, "id" | "createdAt" | "updatedAt"> & { createdAt?: string }
) {
  const ref = doc(userCollection(uid, "dailySchedules"), schedule.dateKey);
  const existing = await getDoc(ref);
  await setDoc(
    ref,
    withoutUndefined({
      ...schedule,
      createdAt: existing.exists() ? existing.data().createdAt : schedule.createdAt ?? now(),
      updatedAt: now()
    }),
    { merge: true }
  );
}

export async function createThought(uid: string, thought: NewThought) {
  const createdAt = now();
  await addDoc(userCollection(uid, "thoughts"), withoutUndefined({ isFavorite: false, ...thought, createdAt, updatedAt: createdAt }));
}

export async function updateThought(uid: string, id: string, patch: Partial<Thought>) {
  await updateDoc(doc(userCollection(uid, "thoughts"), id), withoutUndefined({ ...patch, updatedAt: now() }));
}

export async function deleteThought(uid: string, id: string) {
  await deleteDoc(doc(userCollection(uid, "thoughts"), id));
}

export async function saveThoughtSelection(uid: string, selection: Omit<ThoughtSelection, "id" | "updatedAt">) {
  await setDoc(doc(userCollection(uid, "thoughtSelections"), selection.dateKey), withoutUndefined({ ...selection, updatedAt: now() }), {
    merge: true
  });
}

export const q = { where, orderBy };

export function mapDoc<T>(id: string, data: DocumentData) {
  return { id, ...data } as T;
}
