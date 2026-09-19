"use client";

import { orderBy } from "firebase/firestore";
import { RefreshCw, Sparkles, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CheckpointForm, checkpointTypeLabels } from "@/components/checkpoint-form";
import { ClassLogForm } from "@/components/class-log-form";
import { CourseForm } from "@/components/course-form";
import { CourseSessionsEditor } from "@/components/course-sessions-editor";
import { EmptyState, focusSection } from "@/components/empty-state";
import { InfoHint } from "@/components/info-hint";
import { ModuleGate } from "@/components/module-gate";
import { RecurringCommitmentForm } from "@/components/recurring-commitment-form";
import { RecurringCommitmentRow } from "@/components/recurring-commitment-row";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useUserSettings } from "@/hooks/use-user-settings";
import { callAiTask } from "@/lib/ai/client";
import type { PrepPlanOutput } from "@/lib/ai/schemas";
import { saveClassLogEntry } from "@/lib/classlog";
import { dayOfWeekLabels, effectiveCourseStatus, resyncFutureClassSlots, syncRevisionTemplate } from "@/lib/courses";
import { todayKey } from "@/lib/dates";
import { computeCourseCoverage } from "@/lib/loadindex";
import {
  createCheckpoint,
  createCourse,
  createRecurringTaskTemplate,
  createTerm,
  deleteCheckpoint,
  deleteCourse,
  deleteTerm,
  subscribeCourseClassLogs,
  subscribeCourseTopics,
  updateCheckpoint,
  updateCourse,
  updateRecurringTaskTemplate,
  updateTopic
} from "@/lib/firestore";
import type {
  ClassLog,
  Checkpoint,
  CheckpointStatus,
  Course,
  CourseSession,
  Goal,
  NewCourse,
  NewTerm,
  Paper,
  RecurringTaskTemplate,
  RevisionItem,
  Task,
  Term,
  TermKind,
  Topic
} from "@/types";

const CHECKPOINT_STATUSES: CheckpointStatus[] = ["upcoming", "prepping", "submitted", "done", "missed"];

function CoursesPageContent() {
  const { user } = useAuth();
  const today = todayKey();
  const { settings } = useUserSettings();
  const workMinutes = settings.workMinutes ?? 25;
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: revisionItems } = useUserCollection<RevisionItem>("revisionItems", useMemo(() => [], []));
  const { checkpointsByCourse } = useCourseCheckpoints(courses);
  // Fetched in full and grouped client-side, same as every other collection on this page (and
  // everywhere else in the app — there's no where()-filtered client subscription anywhere in this
  // codebase) rather than one filtered subscription per course card.
  const { items: recurringTemplates } = useUserCollection<RecurringTaskTemplate>("recurringTaskTemplates", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: tasks } = useUserCollection<Task>("tasks", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: goals } = useUserCollection<Goal>("goals", useMemo(() => [orderBy("createdAt", "desc")], []));

  /** A new course's revision hours (if set at creation) get their auto "Revise" template the same
   * turn it's created — `createCourse` returns the new id specifically so this doesn't need a
   * second round-trip to look it up. */
  async function handleCreateCourse(course: NewCourse) {
    const id = await createCourse(user!.uid, course);
    if (course.targetMinutesPerWeek) {
      await syncRevisionTemplate(
        user!.uid,
        { id, name: course.name, targetMinutesPerWeek: course.targetMinutesPerWeek, startDate: course.startDate, endDate: course.endDate },
        [],
        workMinutes
      );
    }
  }

  return (
    <>
      <SectionHeader title="Courses" eyebrow="Terms, coursework, and class schedule" />
      <TermsPanel terms={terms} onCreate={(term) => createTerm(user!.uid, term)} onDelete={(id) => deleteTerm(user!.uid, id)} />
      <div className="mt-6 grid gap-6 xl:grid-cols-[380px_1fr]">
        <section id="course-add" className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Add a course</h2>
          <CourseForm terms={terms} onCreate={handleCreateCourse} />
        </section>
        <section className="space-y-4">
          {courses.length === 0 ? (
            <EmptyState
              sentence="Your classes, assessments, and what each lecture covered."
              primary={{ label: "Add a course", onClick: () => focusSection("course-add") }}
            />
          ) : (
            courses.map((course) => (
              <CourseCard
                key={course.id}
                course={course}
                terms={terms}
                today={today}
                workMinutes={workMinutes}
                checkpoints={checkpointsByCourse[course.id] ?? []}
                revisionItems={revisionItems}
                recurringTemplates={recurringTemplates.filter((item) => item.courseId === course.id)}
                papers={papers.filter((item) => item.relatedCourseId === course.id)}
                openTasks={tasks.filter((item) => item.courseId === course.id && item.status !== "done")}
                linkedGoals={goals.filter((item) => item.linked.courseIds.includes(course.id))}
              />
            ))
          )}
        </section>
      </div>
    </>
  );
}

function TermsPanel({ terms, onCreate, onDelete }: { terms: Term[]; onCreate: (term: NewTerm) => Promise<void>; onDelete: (id: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TermKind>("semester");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !startDate || !endDate) return;
    await onCreate({ name: name.trim(), kind, startDate, endDate });
    setName("");
    setStartDate("");
    setEndDate("");
  }

  return (
    <section className="card p-5">
      <h2 className="mb-3 text-lg font-semibold">Terms</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {terms.map((term) => (
          <span key={term.id} className="flex items-center gap-2 rounded-md bg-ink-50 px-2.5 py-1.5 text-xs dark:bg-ink-800">
            <span className="font-medium">{term.name}</span>
            <span className="text-ink-500">
              {term.kind} · {term.startDate} to {term.endDate}
            </span>
            <button className="text-ink-400 hover:text-red-600" onClick={() => onDelete(term.id)} aria-label="Delete term">
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        ))}
        {terms.length === 0 ? <p className="text-sm text-ink-500">No terms yet — courses without a term are always treated as active.</p> : null}
      </div>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_130px_150px_150px_auto]">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Term name (e.g. Sem 3)" />
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as TermKind)}>
          <option value="semester">Semester</option>
          <option value="break">Break</option>
          <option value="none">None</option>
        </select>
        <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        <button className="btn-secondary">Add term</button>
      </form>
    </section>
  );
}

function CourseCard({
  course,
  terms,
  today,
  workMinutes,
  checkpoints,
  revisionItems,
  recurringTemplates,
  papers,
  openTasks,
  linkedGoals
}: {
  course: Course;
  terms: Term[];
  today: string;
  workMinutes: number;
  checkpoints: Checkpoint[];
  revisionItems: RevisionItem[];
  recurringTemplates: RecurringTaskTemplate[];
  papers: Paper[];
  openTasks: Task[];
  linkedGoals: Goal[];
}) {
  const { user } = useAuth();
  const [editingSessions, setEditingSessions] = useState(false);
  const [logs, setLogs] = useState<ClassLog[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [revisionHours, setRevisionHours] = useState(course.targetMinutesPerWeek ? String(course.targetMinutesPerWeek / 60) : "");
  const [savingRevisionHours, setSavingRevisionHours] = useState(false);
  const status = effectiveCourseStatus(course, today);
  const term = terms.find((item) => item.id === course.termId);
  const coverage = computeCourseCoverage(topics, revisionItems, course.id);

  useEffect(() => {
    if (!user) return;
    return subscribeCourseClassLogs(user.uid, course.id, setLogs);
  }, [user, course.id]);

  useEffect(() => {
    if (!user) return;
    return subscribeCourseTopics(user.uid, course.id, setTopics);
  }, [user, course.id]);

  async function saveSessions(sessions: CourseSession[]) {
    if (!user) return;
    await updateCourse(user.uid, course.id, { sessions });
    await resyncFutureClassSlots(user.uid, { ...course, sessions }, today);
    setEditingSessions(false);
  }

  /** plan §7's open question, resolved: a course flipped to "dropped" OR "completed" also pauses
   * (not deletes — still reactivatable) every one of its recurring templates in the same write,
   * rather than relying only on each template's own copied-at-creation endDate — a course with no
   * term and no explicit dates has no endDate to copy in the first place, so without this a
   * template on a manually-completed course would otherwise keep generating forever. */
  async function changeStatus(nextStatus: Course["status"]) {
    if (!user) return;
    await updateCourse(user.uid, course.id, { status: nextStatus });
    if (nextStatus === "active") return;
    await Promise.all(
      recurringTemplates.filter((template) => template.active).map((template) => updateRecurringTaskTemplate(user.uid, template.id, { active: false }))
    );
  }

  /** "number of hours can be set by user in the course" — stores 0 rather than `undefined` when
   * cleared, since `updateCourse`'s patch runs through `withoutUndefined` and an `undefined` value
   * would just get silently dropped instead of clearing the field in Firestore. */
  async function saveRevisionHours() {
    if (!user) return;
    setSavingRevisionHours(true);
    const targetMinutesPerWeek = revisionHours ? Math.round(Number(revisionHours) * 60) : 0;
    await updateCourse(user.uid, course.id, { targetMinutesPerWeek });
    await syncRevisionTemplate(
      user.uid,
      { id: course.id, name: course.name, targetMinutesPerWeek, startDate: course.startDate, endDate: course.endDate },
      recurringTemplates,
      workMinutes
    );
    setSavingRevisionHours(false);
  }

  async function generateNow() {
    if (!user) return;
    setGenerating(true);
    setGenerateError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/daily-loop/recurring-tasks", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Failed to generate recurring tasks.");
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Failed to generate recurring tasks.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <article className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold">{course.name}</h3>
            <StatusBadge status={status} />
          </div>
          <p className="text-sm text-ink-500 dark:text-ink-400">
            {[course.code, course.instructor, term?.name].filter(Boolean).join(" · ") || "No details"}
          </p>
          {topics.length > 0 ? (
            <p className="mt-1 flex items-center gap-1 text-xs text-ink-500 dark:text-ink-400">
              Topics revised: {Math.round(coverage * 100)}% at least once
              <InfoHint term="topicsRevised" />
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 text-xs" value={course.status} onChange={(e) => changeStatus(e.target.value as Course["status"])}>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="dropped">Dropped</option>
          </select>
          <button className="btn-secondary px-2 py-1.5" onClick={() => user && deleteCourse(user.uid, course.id)} aria-label="Delete course">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {course.sessions.map((session) => (
          <span key={session.id} className="rounded-md bg-ink-50 px-2 py-1 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">
            {dayOfWeekLabels[session.dayOfWeek].slice(0, 3)} {session.startTime}-{session.endTime}
          </span>
        ))}
        <button className="text-xs font-medium text-moss-700 hover:underline dark:text-moss-400" onClick={() => setEditingSessions((current) => !current)}>
          {editingSessions ? "Close" : "Edit sessions"}
        </button>
      </div>
      {editingSessions ? (
        <CourseSessionsEditor initialSessions={course.sessions} onSave={saveSessions} onCancel={() => setEditingSessions(false)} />
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-ink-500">
          Revision hours/week
          <input
            className="input w-20 py-1"
            type="number"
            min={0}
            step={0.5}
            value={revisionHours}
            onChange={(e) => setRevisionHours(e.target.value)}
          />
        </label>
        <button className="btn-secondary py-1 text-xs" onClick={saveRevisionHours} disabled={savingRevisionHours}>
          {savingRevisionHours ? "Saving..." : "Save"}
        </button>
        <InfoHint term="revisionHoursPerWeek" />
      </div>

      <div className="mt-4">
        <p className="label mb-2 flex items-center gap-1">
          Assessments
          <InfoHint term="assessment" />
        </p>
        <div className="space-y-2">
          {checkpoints.map((checkpoint) => (
            <CheckpointRow key={checkpoint.id} courseId={course.id} checkpoint={checkpoint} topics={topics} />
          ))}
          {checkpoints.length === 0 ? <p className="text-sm text-ink-500">No assessments yet.</p> : null}
        </div>
        <div className="mt-2">
          <CheckpointForm courseId={course.id} onCreate={(checkpoint) => createCheckpoint(user!.uid, course.id, checkpoint)} />
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="label flex items-center gap-1">Recurring commitments</p>
          <button
            className="btn-secondary py-1 text-xs"
            onClick={generateNow}
            disabled={generating}
            title="Generates due tasks for every recurring commitment across all your courses, not just this one — the daily cron does this automatically."
          >
            <RefreshCw className={generating ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
            {generating ? "Generating..." : "Generate now"}
          </button>
        </div>
        {generateError ? <p className="mb-2 text-xs text-red-600 dark:text-red-400">{generateError}</p> : null}
        <div className="space-y-2">
          {recurringTemplates.map((template) => (
            <RecurringCommitmentRow key={template.id} uid={user!.uid} template={template} />
          ))}
          {recurringTemplates.length === 0 ? <p className="text-sm text-ink-500">No recurring commitments yet — a TA meeting, office hours, or a problem set due every week.</p> : null}
        </div>
        <div className="mt-2">
          <RecurringCommitmentForm
            courseStartDate={course.startDate}
            courseEndDate={course.endDate}
            onCreate={(template) => createRecurringTaskTemplate(user!.uid, { ...template, courseId: course.id })}
          />
        </div>
      </div>

      {papers.length > 0 || openTasks.length > 0 || linkedGoals.length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {papers.length > 0 ? (
            <div>
              <p className="label mb-2">Papers</p>
              <div className="space-y-1">
                {papers.map((paper) => (
                  <Link key={paper.id} href={`/papers/${paper.id}`} className="block truncate rounded-md bg-ink-50 px-2 py-1 text-xs text-ink-600 hover:underline dark:bg-ink-800 dark:text-ink-300">
                    {paper.title}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
          {openTasks.length > 0 ? (
            <div>
              <p className="label mb-2">Open tasks</p>
              <div className="space-y-1">
                {openTasks.map((task) => (
                  <p key={task.id} className="truncate rounded-md bg-ink-50 px-2 py-1 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                    {task.title}
                  </p>
                ))}
              </div>
            </div>
          ) : null}
          {linkedGoals.length > 0 ? (
            <div>
              <p className="label mb-2">Linked goals</p>
              <div className="space-y-1">
                {linkedGoals.map((goal) => (
                  <p key={goal.id} className="truncate rounded-md bg-ink-50 px-2 py-1 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                    {goal.title}
                  </p>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <p className="label mb-2 flex items-center gap-1">
            Log a class
            <InfoHint term="logAClass" />
          </p>
          <ClassLogForm onSave={(input) => saveClassLogEntry(user!.uid, course, input)} />
          {logs.length > 0 ? (
            <div className="mt-2 space-y-1">
              {logs.slice(0, 5).map((log) => (
                <p key={log.id} className="text-xs text-ink-500">
                  {log.date} · {log.attendance} · {log.topicIds.length} topic{log.topicIds.length === 1 ? "" : "s"}
                </p>
              ))}
            </div>
          ) : null}
        </div>
        <div>
          <p className="label mb-2">Topics</p>
          <div className="max-h-48 space-y-1 overflow-auto">
            {topics.map((topic) => (
              <div key={topic.id} className="flex items-center justify-between gap-2 rounded-md bg-ink-50 px-2 py-1 text-xs dark:bg-ink-800">
                <span className={topic.status === "retired" ? "text-ink-400 line-through" : ""}>{topic.title}</span>
                <div className="flex items-center gap-2">
                  <span className="text-ink-500">confidence {topic.confidence}/5</span>
                  <button
                    className="text-ink-400 hover:text-moss-700"
                    onClick={() => user && updateTopic(user.uid, topic.id, { status: topic.status === "active" ? "retired" : "active" })}
                  >
                    {topic.status === "active" ? "Retire" : "Reactivate"}
                  </button>
                </div>
              </div>
            ))}
            {topics.length === 0 ? <p className="text-sm text-ink-500">Topics appear here once you log a class.</p> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: Course["status"] }) {
  const styles: Record<Course["status"], string> = {
    active: "bg-moss-600/10 text-moss-700 dark:text-moss-400",
    completed: "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300",
    dropped: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
  };
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${styles[status]}`}>{status}</span>;
}

function CheckpointRow({ courseId, checkpoint, topics }: { courseId: string; checkpoint: Checkpoint; topics: Topic[] }) {
  const { user } = useAuth();
  const [score, setScore] = useState("");
  const [max, setMax] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const showResult = checkpoint.status === "done";

  async function generatePrepPlan() {
    if (!user) return;
    setGenerating(true);
    setError("");
    try {
      const scopedTopics = checkpoint.topicIds.length > 0 ? topics.filter((topic) => checkpoint.topicIds.includes(topic.id)) : topics;
      const { output } = await callAiTask<PrepPlanOutput>(user, "checkpoint.prepPlan", {
        title: checkpoint.title,
        type: checkpoint.type,
        dueAt: checkpoint.dueAt,
        topics: scopedTopics.map((topic) => ({ title: topic.title, confidence: topic.confidence }))
      });
      await updateCheckpoint(user.uid, courseId, checkpoint.id, { prepPlan: output.steps });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate a prep plan.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-ink-50 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-ink-600 dark:bg-ink-800 dark:text-ink-300">
            {checkpointTypeLabels[checkpoint.type]}
          </span>
          <span>{checkpoint.title}</span>
          {checkpoint.requiresPrep ? <Star className="h-3 w-3 text-amberline" aria-label="Needs prep" /> : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-500">{checkpoint.dueAt}</span>
          <select
            className="input py-1 text-xs"
            value={checkpoint.status}
            onChange={(e) => user && updateCheckpoint(user.uid, courseId, checkpoint.id, { status: e.target.value as CheckpointStatus })}
          >
            {CHECKPOINT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button className="text-ink-400 hover:text-red-600" onClick={() => user && deleteCheckpoint(user.uid, courseId, checkpoint.id)} aria-label="Delete assessment">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {checkpoint.requiresPrep ? (
        <div className="mt-2">
          <button className="btn-secondary py-1 text-xs" onClick={generatePrepPlan} disabled={generating}>
            <Sparkles className="h-3 w-3" />
            {generating ? "Generating..." : checkpoint.prepPlan?.length ? "Regenerate prep plan" : "Generate prep plan"}
          </button>
          {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          {checkpoint.prepPlan?.length ? (
            <ol className="mt-2 list-inside list-decimal space-y-0.5 text-xs text-ink-600 dark:text-ink-300">
              {checkpoint.prepPlan.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      {showResult ? (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-ink-500">Result:</span>
          <input className="input w-16 py-1" type="number" placeholder="score" value={checkpoint.result?.score ?? score} onChange={(e) => setScore(e.target.value)} />
          <span>/</span>
          <input className="input w-16 py-1" type="number" placeholder="max" value={checkpoint.result?.max ?? max} onChange={(e) => setMax(e.target.value)} />
          <button
            className="btn-secondary px-2 py-1"
            onClick={() => user && score && max && updateCheckpoint(user.uid, courseId, checkpoint.id, { result: { score: Number(score), max: Number(max) } })}
          >
            Save
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function CoursesPage() {
  return (
    <ModuleGate moduleId="courses">
      <CoursesPageContent />
    </ModuleGate>
  );
}
