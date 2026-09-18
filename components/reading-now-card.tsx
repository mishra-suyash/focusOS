"use client";

import Link from "next/link";
import type { Paper } from "@/types";

/** Replaces the old break-only "Break focus" card (plan §9.4) — shows year-round, not just during a semester break. */
export function ReadingNowCard({ papers, onBreak }: { papers: Paper[]; onBreak?: boolean }) {
  const reading = papers.filter((paper) => paper.status === "reading").slice(0, 5);
  const toRead = papers.filter((paper) => paper.status === "to_read").slice(0, 5 - reading.length);
  const queue = [...reading, ...toRead];

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Reading now</h2>
        <Link href="/papers" className="text-xs font-medium text-moss-700 dark:text-moss-400">Papers</Link>
      </div>
      {onBreak ? (
        <p className="mb-2 text-xs text-ink-500">No active semester term today — no class blocks are generated.</p>
      ) : null}
      <div className="space-y-1">
        {queue.map((paper) => (
          <Link
            key={paper.id}
            href={`/papers/${paper.id}`}
            className="block truncate rounded-md bg-ink-50 px-2 py-1.5 text-sm hover:bg-ink-100 dark:bg-ink-800 dark:hover:bg-ink-700"
          >
            {paper.title}
          </Link>
        ))}
        {queue.length === 0 ? <p className="text-sm text-ink-500">Nothing in progress — add a paper to your reading list.</p> : null}
      </div>
    </section>
  );
}
