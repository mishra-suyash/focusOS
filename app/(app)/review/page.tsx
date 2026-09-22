"use client";

/**
 * NOTE for maintainers: this route (`/review`, singular — the spaced-repetition "Revise" queue)
 * is unrelated to `/reviews/daily` and `/reviews/weekly` (plural — the Daily wrap-up / Weekly
 * check-in reflection pages). Also unrelated to a course's "Revision hours/week" field, which
 * creates a plain recurring Task rather than feeding this queue. See plan/13's T5 — a real naming
 * collision across three independent features, kept distinct in nav copy but not in route/code
 * naming. Don't assume shared logic between these just because the names rhyme.
 */
import { orderBy } from "firebase/firestore";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ModuleGate } from "@/components/module-gate";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useCourseCheckpoints } from "@/hooks/use-course-checkpoints";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { startAiJob } from "@/lib/ai/client";
import type { GroupSynthesisOutput } from "@/lib/ai/schemas";
import { todayKey } from "@/lib/dates";
import { subscribeAiJob, subscribeDueRevisionItems, updatePaperGroup, updateRevisionItem } from "@/lib/firestore";
import {
  DEFAULT_MAX_REVISIONS_PER_DAY,
  DEFAULT_MAX_REVISION_MINUTES_PER_DAY,
  buildReviewQueue,
  fallbackRecallPrompt,
  gradeRevisionItem
} from "@/lib/revision";
import type { Course, Pass1Output, Pass2Output, Paper, PaperGroup, RevisionGrade, RevisionItem } from "@/types";

const GRADE_BUTTONS: { grade: RevisionGrade; label: string; hint: string; keys: string[] }[] = [
  { grade: "again", label: "Again", hint: "1", keys: ["1"] },
  { grade: "hard", label: "Hard", hint: "2", keys: ["2"] },
  { grade: "good", label: "Good", hint: "3", keys: ["3"] },
  { grade: "easy", label: "Easy", hint: "4", keys: ["4"] }
];

function ReviewPageContent() {
  const { user } = useAuth();
  const today = todayKey();
  const { settings } = useUserSettings();
  const [dueItems, setDueItems] = useState<RevisionItem[]>([]);
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: paperGroups } = useUserCollection<PaperGroup>("paperGroups", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { allCheckpoints } = useCourseCheckpoints(courses);
  const [revealed, setRevealed] = useState(false);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [synthesis, setSynthesis] = useState("");
  const [draftJobId, setDraftJobId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState("");

  useEffect(() => {
    if (!user) {
      setDueItems([]);
      return;
    }
    return subscribeDueRevisionItems(user.uid, today, setDueItems);
  }, [user, today]);

  const queue = useMemo(
    () =>
      buildReviewQueue(dueItems, allCheckpoints, today, {
        maxItems: settings.maxRevisionsPerDay ?? DEFAULT_MAX_REVISIONS_PER_DAY,
        maxMinutes: settings.maxRevisionMinutesPerDay ?? DEFAULT_MAX_REVISION_MINUTES_PER_DAY
      }),
    [dueItems, allCheckpoints, today, settings.maxRevisionsPerDay, settings.maxRevisionMinutesPerDay]
  );

  const current = queue[0];
  const course = courses.find((item) => item.id === current?.courseId);
  const group = current?.kind === "paperGroup" ? paperGroups.find((item) => item.id === current.refId) : undefined;
  const groupPapers = group ? papers.filter((paper) => group.paperIds.includes(paper.id)) : [];
  const overdueCount = dueItems.filter((item) => item.dueDate < today).length;

  useEffect(() => {
    setSynthesis("");
  }, [current?.id]);

  async function draftSynthesis() {
    if (!user || !group) return;
    setDraftError("");
    try {
      const jobId = await startAiJob(
        user,
        "group.synthesis",
        {
          groupName: group.name,
          purpose: group.purpose,
          papers: groupPapers.map((paper) => ({
            title: paper.title,
            summary: (paper.pass2?.output as Pass2Output | undefined)?.summary,
            keyPoints: (paper.pass2?.output as Pass2Output | undefined)?.keyPoints
          }))
        },
        group.id
      );
      setDraftJobId(jobId);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "Failed to start synthesis job.");
    }
  }

  useEffect(() => {
    if (!user || !draftJobId) return;
    return subscribeAiJob(user.uid, draftJobId, (job) => {
      if (!job) return;
      if (job.status === "done") {
        const output = job.output as GroupSynthesisOutput | undefined;
        if (output?.synthesis) setSynthesis(output.synthesis);
        setDraftJobId(null);
      } else if (job.status === "failed") {
        setDraftError(job.error ?? "Synthesis failed.");
        setDraftJobId(null);
      }
    });
  }, [user, draftJobId]);

  async function grade(g: RevisionGrade) {
    if (!user || !current) return;
    if (group && synthesis.trim()) {
      await updatePaperGroup(user.uid, group.id, { lastSynthesis: { text: synthesis.trim(), at: new Date().toISOString() } });
    }
    const patch = gradeRevisionItem(current, g, today);
    await updateRevisionItem(user.uid, current.id, patch);
    setReviewedCount((count) => count + 1);
    setRevealed(false);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!current) return;
      if (!group && !revealed) {
        if (event.key === " " || event.key === "Enter") setRevealed(true);
        return;
      }
      const match = GRADE_BUTTONS.find((button) => button.keys.includes(event.key));
      if (match) grade(match.grade);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, revealed, group]);

  return (
    <>
      <SectionHeader
        title="Revise"
        eyebrow={`${
          queue.length < dueItems.length ? `${queue.length} of ${dueItems.length} due now (daily cap reached)` : `${queue.length} due now`
        } · ${overdueCount} overdue · ${reviewedCount} reviewed today`}
      />
      {current ? (
        group ? (
          <section className="card mx-auto max-w-3xl p-6">
            <p className="label mb-3 text-center">Paper set revision · {group.name}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {groupPapers.map((paper) => {
                const summary =
                  (paper.pass2?.output as Pass2Output | undefined)?.summary ??
                  (paper.pass1?.output as Pass1Output | undefined)?.category ??
                  "No pass completed yet.";
                return (
                  <div key={paper.id} className="rounded-md bg-ink-50 p-3 text-sm dark:bg-ink-800">
                    <p className="mb-1 font-medium">{paper.title}</p>
                    <p className="text-ink-600 dark:text-ink-300">{summary}</p>
                  </div>
                );
              })}
            </div>
            <label className="mt-4 block">
              <div className="mb-1 flex items-center justify-between">
                <span className="label block">What&apos;s the through-line, and what changed since last time?</span>
                <button type="button" className="btn-secondary py-1 text-xs" onClick={draftSynthesis} disabled={Boolean(draftJobId)}>
                  <Sparkles className="h-3.5 w-3.5" />
                  {draftJobId ? "Drafting..." : "Draft with AI"}
                </button>
              </div>
              <textarea className="input min-h-20" value={synthesis} onChange={(e) => setSynthesis(e.target.value)} />
              {draftError ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{draftError}</p> : null}
            </label>
            <div className="mt-4 grid grid-cols-4 gap-2">
              {GRADE_BUTTONS.map((button) => (
                <button key={button.grade} className="btn-secondary flex-col py-3 text-sm" onClick={() => grade(button.grade)}>
                  {button.label}
                  <span className="mt-1 text-xs text-ink-400">({button.hint})</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="card mx-auto max-w-xl p-6 text-center">
            <p className="label mb-2">{course ? course.name : current.kind}</p>
            {!revealed ? (
              <>
                <p className="mt-4 text-lg leading-8">{fallbackRecallPrompt(current.title)}</p>
                <p className="mt-2 text-xs text-ink-500">Think it through, then reveal — retrieval is the point, not recognition.</p>
                <button className="btn-primary mt-6" onClick={() => setRevealed(true)}>
                  Show answer (space)
                </button>
              </>
            ) : (
              <>
                <h2 className="mt-4 text-2xl font-semibold">{current.title}</h2>
                <p className="mt-2 text-sm text-ink-500">
                  Reviewed {current.reps}× · {current.lapses} lapse{current.lapses === 1 ? "" : "s"}
                  {current.lastReviewedAt ? ` · last on ${current.lastReviewedAt.slice(0, 10)}` : ""}
                </p>
                <div className="mt-6 grid grid-cols-4 gap-2">
                  {GRADE_BUTTONS.map((button) => (
                    <button key={button.grade} className="btn-secondary flex-col py-3 text-sm" onClick={() => grade(button.grade)}>
                      {button.label}
                      <span className="mt-1 text-xs text-ink-400">({button.hint})</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )
      ) : (
        <div className="card mx-auto max-w-xl p-10 text-center">
          <p className="text-sm text-ink-600 dark:text-ink-300">
            Cards appear after you log a class, save a paper for later, grade a Deep dive structure-recall, or start revision on a
            paper set.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Link href="/courses" className="btn-primary px-3 py-1.5 text-xs">Log a class</Link>
            <Link href="/papers" className="btn-secondary px-3 py-1.5 text-xs">Add a paper</Link>
          </div>
        </div>
      )}
    </>
  );
}

export default function ReviewPage() {
  return (
    <ModuleGate moduleId="revise">
      <ReviewPageContent />
    </ModuleGate>
  );
}
