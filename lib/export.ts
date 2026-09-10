import { getDocs, orderBy, type QueryConstraint } from "firebase/firestore";
import { fetchCollection, fetchCourseCheckpoints, fetchCourseClassLogs, paperSubcollection } from "@/lib/firestore";
import type {
  AiInsight,
  Checkpoint,
  ClassLog,
  Course,
  Day,
  DailySchedule,
  DayTemplate,
  FileRef,
  Paper,
  PaperGroup,
  PaperNote,
  PomodoroSession,
  RevisionItem,
  Task,
  Term,
  Topic,
  WeeklyReview
} from "@/types";

const COLLECTION_ORDER: Record<string, QueryConstraint[]> = {
  tasks: [orderBy("createdAt", "desc")],
  pomodoroSessions: [orderBy("completedAt", "desc")],
  days: [orderBy("date", "desc")],
  dailySchedules: [orderBy("updatedAt", "desc")],
  dayTemplates: [orderBy("createdAt", "desc")],
  weeklyReviews: [orderBy("updatedAt", "desc")],
  terms: [orderBy("startDate", "desc")],
  courses: [orderBy("createdAt", "desc")],
  topics: [orderBy("createdAt", "desc")],
  revisionItems: [orderBy("dueDate", "asc")],
  papers: [orderBy("createdAt", "desc")],
  paperGroups: [orderBy("createdAt", "desc")],
  files: [],
  aiInsights: [orderBy("date", "desc")]
};

const COLLECTIONS = Object.keys(COLLECTION_ORDER) as (keyof typeof COLLECTION_ORDER)[];

export interface FullExport {
  exportedAt: string;
  tasks: Task[];
  pomodoroSessions: PomodoroSession[];
  days: Day[];
  dailySchedules: DailySchedule[];
  dayTemplates: DayTemplate[];
  weeklyReviews: WeeklyReview[];
  terms: Term[];
  courses: Course[];
  topics: Topic[];
  revisionItems: RevisionItem[];
  papers: Paper[];
  paperGroups: PaperGroup[];
  files: FileRef[];
  aiInsights: AiInsight[];
  checkpoints: Checkpoint[];
  classLogs: ClassLog[];
  paperNotes: PaperNote[];
}

export async function buildFullExport(uid: string): Promise<FullExport> {
  const entries = await Promise.all(COLLECTIONS.map((name) => fetchCollection(uid, name, COLLECTION_ORDER[name]).catch(() => [])));
  const data = Object.fromEntries(COLLECTIONS.map((name, index) => [name, entries[index]])) as Omit<
    FullExport,
    "exportedAt" | "checkpoints" | "classLogs" | "paperNotes"
  >;

  const courses = data.courses;
  const papers = data.papers;
  const [checkpoints, classLogs, paperNotes] = await Promise.all([
    Promise.all(courses.map((course) => fetchCourseCheckpoints(uid, course.id))),
    Promise.all(courses.map((course) => fetchCourseClassLogs(uid, course.id))),
    Promise.all(
      papers.map(async (paper) => {
        const snapshot = await getDocs(paperSubcollection(uid, paper.id, "notes"));
        return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as PaperNote);
      })
    )
  ]);

  return {
    exportedAt: new Date().toISOString(),
    ...data,
    checkpoints: checkpoints.flat(),
    classLogs: classLogs.flat(),
    paperNotes: paperNotes.flat()
  };
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function downloadFullExportJson(uid: string) {
  const data = await buildFullExport(uid);
  downloadBlob(JSON.stringify(data, null, 2), `focusos-export-${data.exportedAt.slice(0, 10)}.json`, "application/json");
}

export async function downloadPomodoroCsv(uid: string) {
  const sessions = await fetchCollection<PomodoroSession>(uid, "pomodoroSessions", [orderBy("completedAt", "desc")]);
  const headers = ["completedAt", "label", "category", "mode", "minutes", "cycle", "taskId", "slotId", "paperId", "passNo", "productivityRating", "comment"];
  const rows = sessions.map((session) =>
    headers.map((key) => csvCell(session[key as keyof PomodoroSession])).join(",")
  );
  downloadBlob([headers.join(","), ...rows].join("\n"), `focusos-pomodoro-log-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv");
}

function csvCell(value: unknown) {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/"/g, '""');
  return /[",\n]/.test(text) ? `"${text}"` : text;
}
