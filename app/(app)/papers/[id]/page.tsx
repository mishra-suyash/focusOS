"use client";

import { ArrowLeft, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { InfoHint } from "@/components/info-hint";
import { LayeredNotesCard } from "@/components/layered-notes-card";
import { MoreOptions } from "@/components/more-options";
import { PaperAnnotationViewer } from "@/components/paper-annotation-viewer";
import { PaperFileAttach } from "@/components/paper-file-attach";
import { PaperNotesPanel } from "@/components/paper-notes-panel";
import { PaperPassSection } from "@/components/paper-pass-section";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { callAiTask } from "@/lib/ai/client";
import type { ReadingPlanOutput } from "@/lib/ai/schemas";
import { subscribeDoc, updatePaper } from "@/lib/firestore";
import { paperStatusLabels } from "@/lib/papers";
import { BUILTIN_READING_GOAL_PRESETS } from "@/lib/templates/builtin/reading-goal-presets";
import type { FileRef, GoalKind, Paper } from "@/types";

const GOAL_KINDS: GoalKind[] = ["survey", "method", "baseline", "related-work", "reproduce", "critique"];

export default function PaperDetailPage() {
  const params = useParams<{ id: string }>();
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const [paper, setPaper] = useState<Paper | null>(null);
  const [file, setFile] = useState<FileRef | null>(null);
  const [goal, setGoal] = useState("");
  const [goalKind, setGoalKind] = useState<GoalKind | "">("");

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
          <p className="mt-1 text-lg font-semibold">{paperStatusLabels[paper.status]}</p>
        </div>
        <div className="card p-3">
          <p className="label">Progress</p>
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

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="card p-5">
            <h2 className="mb-3 flex items-center gap-1 text-lg font-semibold">
              Skim — bird&apos;s-eye view
              <InfoHint term="skim" />
            </h2>
            <PaperPassSection paper={paper} passNo={1} file={file} />
          </section>
          {paper.pass1?.status === "done" && (paper.pass1.output as { verdict?: string })?.verdict === "continue" ? (
            <section className="card p-5">
              <h2 className="mb-3 text-lg font-semibold">Read — grasp the content</h2>
              <PaperPassSection paper={paper} passNo={2} file={file} />
            </section>
          ) : null}
          {paper.pass2?.status === "done" ? (
            <section className="card p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">Deep dive — re-implement (opt-in)</h2>
                {!paper.pass3 ? <span className="text-xs text-ink-500">Most papers never need this pass.</span> : null}
              </div>
              <PaperPassSection paper={paper} passNo={3} file={file} />
            </section>
          ) : null}
          <section className="card p-5">
            <h2 className="mb-3 text-lg font-semibold">Notes</h2>
            <PaperNotesPanel paperId={paper.id} />
          </section>
          {file && isEnabled("paperTools") ? (
            <section className="card p-5">
              <h2 className="mb-3 text-lg font-semibold">Highlights &amp; annotation</h2>
              <PaperAnnotationViewer paperId={paper.id} title={paper.title} pdfUrl={file.url} />
            </section>
          ) : null}
        </div>
        <div className="space-y-6">
          <ReadingPlanCard paper={paper} />
          {file && isEnabled("paperTools") ? <LayeredNotesCard paperId={paper.id} layeredNotes={paper.layeredNotes} /> : null}
          <section className="card p-4">
            <h2 className="mb-3 text-base font-semibold">Why am I reading this?</h2>
            <p className="mb-2 text-xs text-ink-500">Required before starting Skim — the highest-leverage field here, since it conditions everything else.</p>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {GOAL_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="rounded-full border border-ink-200 px-2 py-1 text-[11px] text-ink-600 hover:border-moss-500 hover:text-moss-700 dark:border-ink-700 dark:text-ink-300 dark:hover:text-moss-400"
                  title={BUILTIN_READING_GOAL_PRESETS[kind].text}
                  onClick={() => {
                    const text = BUILTIN_READING_GOAL_PRESETS[kind].text;
                    setGoal(text);
                    setGoalKind(kind);
                    if (user) updatePaper(user.uid, paper.id, { goal: text, goalKind: kind });
                  }}
                >
                  {kind}
                </button>
              ))}
            </div>
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
