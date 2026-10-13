"use client";

import { orderBy } from "firebase/firestore";
import { ExternalLink, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { EmptyState, focusSection } from "@/components/empty-state";
import { InfoHint } from "@/components/info-hint";
import { PaperForm } from "@/components/paper-form";
import { PaperGroupsPanel } from "@/components/paper-groups-panel";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useFeatures } from "@/hooks/use-features";
import { useUserCollection } from "@/hooks/use-user-collection";
import { createPaper, deletePaper, subscribeBlobUsage } from "@/lib/firestore";
import { formatBytes, isNearSoftCap, isOverSoftCap } from "@/lib/files";
import { useReadingPicker } from "@/components/reading-picker";
import { addDaysToKey, todayKey } from "@/lib/dates";
import { updatePaper } from "@/lib/firestore";
import {
  DEFAULT_SHELF_DAYS,
  derivePaperStatus,
  dropPatch,
  nextReadingPass,
  PASS_LABELS,
  pass1DropRate,
  paperStatusLabels,
  queuePatch,
  readingOrder,
  shelvePatch,
  totalReadingMinutes,
  unqueuePatch
} from "@/lib/papers";
import { useUserTier } from "@/lib/tiers";
import type { Course, Paper, PaperStatus, PomodoroSession } from "@/types";

function formatReadingMinutes(minutes: number): string {
  if (minutes <= 0) return "";
  if (minutes < 60) return `${minutes}m reading time`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${rest ? ` ${rest}m` : ""} reading time`;
}

const statusOrder: PaperStatus[] = ["inbox", "to_read", "reading", "shelved", "read", "dropped"];

export default function PapersPage() {
  const { user } = useAuth();
  const { isEnabled } = useFeatures();
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { items: sessions } = useUserCollection<PomodoroSession>("pomodoroSessions", useMemo(() => [], []));
  const [statusFilter, setStatusFilter] = useState<PaperStatus | "all">("all");
  const [tagFilter, setTagFilter] = useState("all");
  // plan/17 F11 — delete removes the paper, its notes and highlights; it used to do so in one click.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [blobBytes, setBlobBytes] = useState(0);
  const { limits: tierLimits } = useUserTier();
  const { openPicker } = useReadingPicker();
  const [inboxSelected, setInboxSelected] = useState<Set<string>>(new Set());
  const inbox = papers.filter((paper) => derivePaperStatus(paper) === "inbox");
  const upNext = papers.filter((paper) => paper.queuedAt && derivePaperStatus(paper) === "to_read").sort(readingOrder);
  const nowIso = () => new Date().toISOString();

  /** Swap two neighbours' `queuedAt` — the order key Up next sorts by (plan/17 §5.1). */
  async function moveInQueue(index: number, by: -1 | 1) {
    const a = upNext[index];
    const b = upNext[index + by];
    if (!user || !a?.queuedAt || !b?.queuedAt) return;
    await updatePaper(user.uid, a.id, { queuedAt: b.queuedAt });
    await updatePaper(user.uid, b.id, { queuedAt: a.queuedAt });
  }

  async function triage(ids: string[], action: "queue" | "shelve" | "drop") {
    if (!user) return;
    for (const id of ids) {
      const paper = papers.find((item) => item.id === id);
      if (!paper) continue;
      const patch =
        action === "queue"
          ? queuePatch(paper, nowIso())
          : action === "shelve"
            ? shelvePatch(paper, addDaysToKey(todayKey(), DEFAULT_SHELF_DAYS))
            : dropPatch(paper, nowIso());
      await updatePaper(user.uid, id, patch);
    }
    setInboxSelected(new Set());
  }

  useEffect(() => {
    if (!user) return;
    return subscribeBlobUsage(user.uid, setBlobBytes);
  }, [user]);

  const tags = Array.from(new Set(papers.flatMap((paper) => paper.tags)));
  const filtered = papers.filter(
    (paper) => (statusFilter === "all" || derivePaperStatus(paper) === statusFilter) && (tagFilter === "all" || paper.tags.includes(tagFilter))
  );
  const dropRate = pass1DropRate(papers);
  const blobQuotaMb = tierLimits.blobQuotaMb;

  return (
    <>
      <SectionHeader title="Papers" eyebrow="Reading list">
        <button className="btn-primary py-1.5 text-xs" onClick={() => openPicker()}>
          Read something
        </button>
      </SectionHeader>
      {isNearSoftCap(blobBytes, blobQuotaMb) ? (
        <div className={`mb-4 rounded-md border p-3 text-sm ${isOverSoftCap(blobBytes, blobQuotaMb) ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200" : "border-amberline/30 bg-amberline/10 text-ink-700 dark:text-ink-200"}`}>
          {formatBytes(blobBytes)} of {blobQuotaMb} MB used for attached PDFs. Consider removing a PDF and keeping just its notes for papers you no longer need the file for.
        </div>
      ) : null}
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div className="card p-4">
          <p className="label">Papers</p>
          <p className="mt-1 text-2xl font-semibold">{papers.length}</p>
        </div>
        <div className="card p-4">
          <p className="label">Skim drop/park rate</p>
          <p className="mt-1 text-2xl font-semibold">{dropRate}%</p>
          <p className="mt-1 text-xs text-ink-500">Below 50% means you&apos;re probably over-reading.</p>
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <section id="paper-add" className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Add a paper</h2>
          <PaperForm onCreate={async (paper) => void (await createPaper(user!.uid, paper))} courses={courses} />
        </section>
        <section className="space-y-6">
          {inbox.length > 0 ? (
            <div className="card p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Inbox · {inbox.length} to triage</h2>
                {inboxSelected.size > 0 ? (
                  <span className="flex gap-2">
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => triage([...inboxSelected], "queue")}>
                      Queue {inboxSelected.size}
                    </button>
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => triage([...inboxSelected], "shelve")}>
                      Shelve {inboxSelected.size}
                    </button>
                    <button className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => triage([...inboxSelected], "drop")}>
                      Drop {inboxSelected.size}
                    </button>
                  </span>
                ) : null}
              </div>
              <p className="mb-2 text-xs text-ink-500">Captured, not looked at yet. Queue it to read, shelve it for {DEFAULT_SHELF_DAYS} days, or drop it.</p>
              <div className="space-y-1">
                {inbox.map((paper) => (
                  <div key={paper.id} className="flex items-center gap-2 rounded-md bg-ink-50 px-2 py-1.5 text-sm dark:bg-ink-800">
                    <input
                      type="checkbox"
                      aria-label={`Select ${paper.title}`}
                      checked={inboxSelected.has(paper.id)}
                      onChange={(e) =>
                        setInboxSelected((current) => {
                          const next = new Set(current);
                          if (e.target.checked) next.add(paper.id);
                          else next.delete(paper.id);
                          return next;
                        })
                      }
                    />
                    <Link href={`/papers/${paper.id}`} className="min-w-0 flex-1 truncate hover:underline">
                      {paper.title}
                    </Link>
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => triage([paper.id], "queue")}>
                      Queue
                    </button>
                    <button className="btn-secondary px-2 py-1 text-xs" onClick={() => triage([paper.id], "shelve")}>
                      Shelve
                    </button>
                    <button className="btn-secondary px-2 py-1 text-xs text-red-600" onClick={() => triage([paper.id], "drop")}>
                      Drop
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {upNext.length > 0 ? (
            <div className="card p-4">
              <h2 className="mb-2 text-base font-semibold">Up next</h2>
              <p className="mb-2 text-xs text-ink-500">What a reading sitting offers first, in this order.</p>
              <ol className="space-y-1">
                {upNext.map((paper, index) => {
                  const passNo = nextReadingPass(paper);
                  return (
                    <li key={paper.id} className="flex items-center gap-2 rounded-md bg-ink-50 px-2 py-1.5 text-sm dark:bg-ink-800">
                      <span className="w-5 text-xs text-ink-500">{index + 1}.</span>
                      <Link href={`/papers/${paper.id}`} className="min-w-0 flex-1 truncate hover:underline">
                        {paper.title}
                      </Link>
                      {passNo ? <span className="text-xs text-ink-500">{PASS_LABELS[passNo]}</span> : null}
                      <button className="btn-secondary px-1.5 py-0.5 text-xs" onClick={() => moveInQueue(index, -1)} disabled={index === 0} aria-label={`Move ${paper.title} up`}>
                        ↑
                      </button>
                      <button className="btn-secondary px-1.5 py-0.5 text-xs" onClick={() => moveInQueue(index, 1)} disabled={index === upNext.length - 1} aria-label={`Move ${paper.title} down`}>
                        ↓
                      </button>
                      <button className="px-1 text-xs text-ink-500 underline" onClick={() => user && updatePaper(user.uid, paper.id, unqueuePatch(paper))}>
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}
          {papers.length === 0 ? (
            <EmptyState
              sentence="Papers you want to read, are reading, or have read."
              primary={{ label: "Add a paper", onClick: () => focusSection("paper-add") }}
            />
          ) : (
          <div>
            <div className="card mb-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as PaperStatus | "all")}>
                  <option value="all">All statuses</option>
                  {statusOrder.map((status) => (
                    <option key={status} value={status}>
                      {paperStatusLabels[status]}
                    </option>
                  ))}
                </select>
                <select className="input" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                  <option value="all">All tags</option>
                  {tags.map((tag) => (
                    <option key={tag} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-3">
              {filtered.map((paper) => (
                <article key={paper.id} className="card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 break-words">
                      <Link href={`/papers/${paper.id}`} className="font-semibold hover:underline">
                        {paper.title}
                      </Link>
                      <p className="text-sm text-ink-500 dark:text-ink-400">
                        {[paper.authors.join(", "), paper.venue, paper.year].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-ink-50 px-2 py-1 text-xs font-medium text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                        {paperStatusLabels[derivePaperStatus(paper)]}
                      </span>
                      {paper.link ? (
                        <a className="btn-secondary px-2 py-1.5" href={paper.link} target="_blank" rel="noreferrer" aria-label="Open link">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                      {confirmDeleteId === paper.id ? (
                        <>
                          <button
                            className="btn-secondary px-2 py-1.5 text-xs text-red-600"
                            onClick={async () => {
                              await deletePaper(user!.uid, paper.id);
                              setConfirmDeleteId(null);
                            }}
                          >
                            Delete paper, notes &amp; highlights
                          </button>
                          <button className="px-1 text-xs text-ink-500 underline" onClick={() => setConfirmDeleteId(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button className="btn-secondary px-2 py-1.5" onClick={() => setConfirmDeleteId(paper.id)} aria-label="Delete paper" title="Delete — to stop reading it, use Drop on its page instead">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
                    <div className="h-full bg-moss-600" style={{ width: `${paper.progress ?? 0}%` }} />
                  </div>
                  {totalReadingMinutes(sessions, paper.id) > 0 ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-ink-500 dark:text-ink-400">
                      {formatReadingMinutes(totalReadingMinutes(sessions, paper.id))}
                      <InfoHint term="readingTime" />
                    </p>
                  ) : null}
                  {paper.tags.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {paper.tags.map((tag) => (
                        <span key={tag} className="rounded-md bg-ink-50 px-2 py-0.5 text-xs text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
              {filtered.length === 0 ? <div className="card p-8 text-center text-sm text-ink-500 dark:text-ink-400">No papers match these filters.</div> : null}
            </div>
          </div>
          )}
          {isEnabled("paperTools") ? <PaperGroupsPanel papers={papers} /> : null}
        </section>
      </div>
    </>
  );
}
