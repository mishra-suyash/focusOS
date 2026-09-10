"use client";

import { orderBy } from "firebase/firestore";
import { ExternalLink, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PaperForm } from "@/components/paper-form";
import { PaperGroupsPanel } from "@/components/paper-groups-panel";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { createPaper, deletePaper, subscribeBlobUsage } from "@/lib/firestore";
import { formatBytes, isNearSoftCap, isOverSoftCap } from "@/lib/files";
import { pass1DropRate, paperStatusLabels } from "@/lib/papers";
import { useUserTier } from "@/lib/tiers";
import type { Paper, PaperStatus } from "@/types";

const statusOrder: PaperStatus[] = ["to_read", "reading", "read", "archived"];

export default function PapersPage() {
  const { user } = useAuth();
  const { items: papers } = useUserCollection<Paper>("papers", useMemo(() => [orderBy("createdAt", "desc")], []));
  const [statusFilter, setStatusFilter] = useState<PaperStatus | "all">("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [blobBytes, setBlobBytes] = useState(0);
  const { limits: tierLimits } = useUserTier();

  useEffect(() => {
    if (!user) return;
    return subscribeBlobUsage(user.uid, setBlobBytes);
  }, [user]);

  const tags = Array.from(new Set(papers.flatMap((paper) => paper.tags)));
  const filtered = papers.filter(
    (paper) => (statusFilter === "all" || paper.status === statusFilter) && (tagFilter === "all" || paper.tags.includes(tagFilter))
  );
  const dropRate = pass1DropRate(papers);
  const blobQuotaMb = tierLimits.blobQuotaMb;

  return (
    <>
      <SectionHeader title="Papers" eyebrow="Reading list" />
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
          <p className="label">Pass 1 drop/park rate</p>
          <p className="mt-1 text-2xl font-semibold">{dropRate}%</p>
          <p className="mt-1 text-xs text-ink-500">Below 50% means you&apos;re probably over-reading.</p>
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Add a paper</h2>
          <PaperForm onCreate={(paper) => createPaper(user!.uid, paper)} />
        </section>
        <section className="space-y-6">
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
                    <div className="min-w-0">
                      <Link href={`/papers/${paper.id}`} className="font-semibold hover:underline">
                        {paper.title}
                      </Link>
                      <p className="text-sm text-ink-500 dark:text-ink-400">
                        {[paper.authors.join(", "), paper.venue, paper.year].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-ink-50 px-2 py-1 text-xs font-medium text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                        {paperStatusLabels[paper.status]}
                      </span>
                      {paper.link ? (
                        <a className="btn-secondary px-2 py-1.5" href={paper.link} target="_blank" rel="noreferrer" aria-label="Open link">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                      <button className="btn-secondary px-2 py-1.5" onClick={() => deletePaper(user!.uid, paper.id)} aria-label="Delete paper">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
                    <div className="h-full bg-moss-600" style={{ width: `${paper.progress ?? 0}%` }} />
                  </div>
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
          <PaperGroupsPanel papers={papers} />
        </section>
      </div>
    </>
  );
}
