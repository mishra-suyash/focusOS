import { adminDb } from "@/lib/firebase-admin";
import { lastSevenDays } from "@/lib/dates";
import type { AiInsightSource, AiProvider, Checkpoint, Course, Day, Goal, Paper, PomodoroSession, Task, Term } from "@/types";

async function fetchAdminCollection<T>(uid: string, name: string): Promise<T[]> {
  const snapshot = await adminDb().collection("users").doc(uid).collection(name).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as T);
}

async function fetchAllCheckpoints(uid: string, courses: Course[]): Promise<Checkpoint[]> {
  const perCourse = await Promise.all(
    courses.map((course) =>
      adminDb()
        .collection("users")
        .doc(uid)
        .collection("courses")
        .doc(course.id)
        .collection("checkpoints")
        .get()
        .then((snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Checkpoint))
    )
  );
  return perCourse.flat();
}

export interface InsightData {
  tasks: Task[];
  sessions: PomodoroSession[];
  days: Day[];
  papers: Paper[];
  checkpoints: Checkpoint[];
  courses: Course[];
  goals: Goal[];
  terms: Term[];
}

export async function fetchInsightData(uid: string): Promise<InsightData> {
  const days = lastSevenDays();
  const [tasks, sessions, dayDocs, papers, courses, goals, terms] = await Promise.all([
    fetchAdminCollection<Task>(uid, "tasks"),
    fetchAdminCollection<PomodoroSession>(uid, "pomodoroSessions"),
    adminDb()
      .collection("users")
      .doc(uid)
      .collection("days")
      .where("date", ">=", days[0])
      .where("date", "<=", days[days.length - 1])
      .get()
      .then((snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Day)),
    fetchAdminCollection<Paper>(uid, "papers"),
    fetchAdminCollection<Course>(uid, "courses"),
    fetchAdminCollection<Goal>(uid, "goals"),
    fetchAdminCollection<Term>(uid, "terms")
  ]);
  const checkpoints = await fetchAllCheckpoints(uid, courses);
  return { tasks, sessions, days: dayDocs, papers, checkpoints, courses, goals, terms };
}

export async function saveInsight(
  uid: string,
  insight: { date: string; provider: AiProvider; summary: string; suggestions: string[]; generatedAt: string; source: AiInsightSource; degraded?: boolean }
) {
  await adminDb().collection("users").doc(uid).collection("aiInsights").doc(insight.date).set(insight, { merge: true });
}
