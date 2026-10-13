"use client";

import { where } from "firebase/firestore";
import { ArrowLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { LayeredNotesCard } from "@/components/layered-notes-card";
import { MoreOptions } from "@/components/more-options";
import { PaperFileAttach } from "@/components/paper-file-attach";
import { PaperNotesPanel } from "@/components/paper-notes-panel";
import { PaperPassSection } from "@/components/paper-pass-section";
import { PaperStatusActions } from "@/components/paper-status-actions";
import { GOAL_KINDS, ReadingGoalChips } from "@/components/reading-goal-chips";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useUserCollection } from "@/hooks/use-user-collection";
import { callAiTask } from "@/lib/ai/client";
import type { ReadingPlanOutput } from "@/lib/ai/schemas";
import { subscribeDoc, updatePaper } from "@/lib/firestore";
import { derivePaperStatus, nextReadingPass, PASS_LABELS, paperStatusLabels, totalReadingMinutes } from "@/lib/papers";
import type { FileRef, GoalKind, Pass1Output, Pass2Output, Paper, PomodoroSession } from "@/types";

export default function PaperDetailPage() {
  const params = useParams<{ id: string }>();
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [file, setFile] = useState<FileRef | null>(null);
  const [goal, setGoal] = useState("");
  const [goalKind, setGoalKind] = useState<GoalKind | "">("");
  // plan/17 §5.5 — a pass's minutes are its focus sessions, so the pass panels need them.
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [where("paperId", "==", params.id)], [params.id]));
  const { items: library } = useUserCollection<Paper>("papers", useMemo(() => [], []));

  useEffect(() => {
    if (!user) return;
    return subscribeDoc<Paper>(user.uid, "papers", params.id, setPaper);
  }, [user, params.id]);

  useEffect(() => {
    if (!user || !paper?.fileId) {
      setFile(null);
      return;
    }
    return subscribeDoc<FileRef>(user.uid, "files", paper.fileId, setFile);
  }, [user, paper?.fileId]);

  useEffect(() => {
    setGoal(paper?.goal ?? "");
    setGoalKind(paper?.goalKind ?? "");
  }, [paper?.goal, paper?.goalKind]);

  if (!paper) {
    return <p className="text-sm text-ink-500">Loading...</p>;
  }

  async function saveGoal() {
    if (!user) return;
    await updatePaper(user.uid, paper!.id, { goal: goal.trim() || undefined, goalKind: goalKind || undefined });
  }

  const status = derivePaperStatus(paper);
  const verdict = (paper.pass1?.output as Pass1Output | undefined)?.verdict;
  const outcome = (paper.pass2?.output as Pass2Output | undefined)?.outcome;
  const owed = nextReadingPass(paper);
  // Read is shown once Skim said "Keep reading", or whenever it's owed or has been touched (a paper
  // back off the shelf after a parked Skim owes Read too).
  const showRead = (paper.pass1?.status === "done" && verdict === "continue") || owed === 2 || (paper.pass2 && paper.pass2.status !== "not_started");
  // plan/17 §5.2 — Deep dive is offered only after "Grasped it" or "Persevere", never after a Read
  // that ended in Set aside or Return later (it used to appear after *any* finished Read).
  const showDeepDive = (paper.pass2?.status === "done" && (outcome === "grasped" || outcome === "persevere")) || (paper.pass3 && paper.pass3.status !== "not_started");
  const readingMinutes = totalReadingMinutes(sessions, paper.id);

  return (
    <>
      <SectionHeader title={paper.title} eyebrow={[paper.authors.join(", "), paper.venue, paper.year].filter(Boolean).join(" · ")}>
        <Link href="/papers" className="btn-secondary py-1.5 text-xs">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to papers
        </Link>
      </SectionHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="card p-3">
          <p className="label">Status</p>
          <p className="mt-1 text-lg font-semibold">
            {paperStatusLabels[status]}
            {owed && status !== "inbox" ? <span className="ml-2 text-xs font-normal text-ink-500">{PASS_LABELS[owed]} next</span> : null}
          </p>
          {readingMinutes > 0 ? <p className="text-xs text-ink-500">{readingMinutes}m read in all</p> : null}
        </div>
        <div className="card p-3">
          <p className="label flex items-center gap-1">
            Progress
            <InfoHint term="paperProgress" />
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
            <div className="h-full bg-moss-600" style={{ width: `${paper.progress ?? 0}%` }} />
          </div>
        </div>
        <div className="card p-3">
          <p className="label">Link</p>
          {paper.link ? (
            <a href={paper.link} target="_blank" rel="noreferrer" className="mt-1 block truncate text-sm text-moss-700 hover:underline dark:text-moss-400">
              {paper.link}
            </a>
          ) : (
            <p className="mt-1 text-sm text-ink-500">None</p>
          )}
        </div>
      </div>

      <PaperStatusActions paper={paper} library={library} sessions={sessions} hasFile={Boolean(file) && isEnabled("paperTools")} className="mb-6" />

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="card p-5" id="pass-1">
            <h2 className="mb-3 flex items-center gap-1 text-lg font-semibold">
              Skim — bird&apos;s-eye view
              <InfoHint term="skim" />
            </h2>
            <PaperPassSection paper={paper} passNo={1} file={file} sessions={sessions} library={library} />
          </section>
          {showRead ? (
            <section className="card p-5" id="pass-2">
              <h2 className="mb-3 flex items-center gap-1 text-lg font-semibold">
                Grasp the content
                <InfoHint term="read" />
              </h2>
              <PaperPassSection paper={paper} passNo={2} file={file} sessions={sessions} library={library} />
            </section>
          ) : null}
          {showDeepDive ? (
            <section className="card p-5" id="pass-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-1 text-lg font-semibold">
                  Deep dive — re-implement (opt-in)
                  <InfoHint term="deepDive" />
                </h2>
                {!paper.pass3 ? <span className="text-xs text-ink-500">Most papers never need this pass.</span> : null}
              </div>
              <PaperPassSection paper={paper} passNo={3} file={file} sessions={sessions} library={library} />
            </section>
          ) : null}
          {paper.previousPasses?.length ? (
            <section className="card p-4 text-sm text-ink-500">
              <p className="label mb-1">Earlier attempts</p>
              <ul className="space-y-1">
                {paper.previousPasses.map((entry, index) => (
                  <li key={index}>
                    {PASS_LABELS[entry.passNo]}
                    {entry.state.completedAt ? ` · finished ${entry.state.completedAt.slice(0, 10)}` : ""}
                    {(entry.state.output as Pass2Output | undefined)?.outcome ? ` · ${(entry.state.output as Pass2Output).outcome.replace(/-/g, " ")}` : ""}
                    {(entry.state.output as Pass2Output | undefined)?.summary ? ` — “${(entry.state.output as Pass2Output).summary}”` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="card p-5">
            <h2 className="mb-3 text-lg font-semibold">Notes</h2>
            <PaperNotesPanel paperId={paper.id} />
          </section>
        </div>
        <div className="space-y-6">
          <ReadingPlanCard paper={paper} />
          {file && isEnabled("paperTools") ? <LayeredNotesCard paperId={paper.id} layeredNotes={paper.layeredNotes} /> : null}
          <section className="card p-4">
            <h2 className="mb-3 text-base font-semibold">Why am I reading this?</h2>
            <p className="mb-2 text-xs text-ink-500">Needed before Skim starts — it shapes what you look for. One tap is enough.</p>
            <div className="mb-2">
              <ReadingGoalChips paper={{ id: paper.id, goalKind: paper.goalKind }} onPicked={(kind, text) => { setGoal(text); setGoalKind(kind); }} />
            </div>
            {paper.goal ? <p className="mb-2 text-xs italic text-ink-600 dark:text-ink-300">&ldquo;{paper.goal}&rdquo;</p> : null}
            <MoreOptions label="Edit free-text">
              <textarea className="input min-h-16" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Why am I reading this?" onBlur={saveGoal} />
              <select
                className="input"
                value={goalKind}
                onChange={(e) => {
                  const next = e.target.value as GoalKind;
                  setGoalKind(next);
                  if (user) updatePaper(user.uid, paper.id, { goalKind: next || undefined });
                }}
              >
                <option value="">Select goal type...</option>
                {GOAL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </MoreOptions>
          </section>
          <section className="card p-4">
            <h2 className="mb-3 text-base font-semibold">PDF</h2>
            <PaperFileAttach paperId={paper.id} fileId={paper.fileId} file={file} />
          </section>
          {paper.tags.length > 0 ? (
            <section className="card p-4">
              <h2 className="mb-3 text-base font-semibold">Tags</h2>
              <div className="flex flex-wrap gap-1">
                {paper.tags.map((tag) => (
                  <span key={tag} className="rounded-md bg-ink-50 px-2 py-0.5 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

function ReadingPlanCard({ paper }: { paper: Paper }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const { output } = await callAiTask<ReadingPlanOutput>(user, "paper.readingPlan", {
        title: paper.title,
        goal: paper.goal,
        goalKind: paper.goalKind
      });
      await updatePaper(user.uid, paper.id, { readingPlan: output.steps });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate a reading plan.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Reading plan</h2>
        <button className="btn-secondary py-1 text-xs" onClick={generate} disabled={loading}>
          <Sparkles className="h-3.5 w-3.5" />
          {loading ? "Generating..." : paper.readingPlan?.length ? "Regenerate" : "Generate"}
        </button>
      </div>
      {error ? <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      {paper.readingPlan?.length ? (
        <ol className="list-inside list-decimal space-y-1 text-sm text-ink-600 dark:text-ink-300">
          {paper.readingPlan.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-ink-500">No plan yet — generate one tailored to why you&apos;re reading this, or fall back to the generic checklist.</p>
      )}
    </section>
  );
}
