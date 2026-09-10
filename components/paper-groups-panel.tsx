"use client";

import { orderBy } from "firebase/firestore";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { createPaperGroup, createRevisionItem, deletePaperGroup, updatePaperGroup } from "@/lib/firestore";
import { computeRepeatedAuthors, computeSharedCitations } from "@/lib/papergroups";
import type { Paper, PaperGroup, PaperGroupKind } from "@/types";

export function PaperGroupsPanel({ papers }: { papers: Paper[] }) {
  const { user } = useAuth();
  const { items: groups } = useUserCollection<PaperGroup>("paperGroups", useMemo(() => [orderBy("createdAt", "desc")], []));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PaperGroupKind>("cluster");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user || !name.trim() || selected.size === 0) return;
    await createPaperGroup(user.uid, { name: name.trim(), kind, paperIds: Array.from(selected) });
    setName("");
    setSelected(new Set());
  }

  async function startRevision(group: PaperGroup) {
    if (!user || group.revisionItemId) return;
    const id = await createRevisionItem(user.uid, {
      kind: "paperGroup",
      refId: group.id,
      title: group.name,
      ladderIndex: 0,
      dueDate: new Date().toISOString().slice(0, 10),
      reps: 0,
      lapses: 0,
      suspended: false
    });
    await updatePaperGroup(user.uid, group.id, { revisionItemId: id });
  }

  return (
    <section className="card p-5">
      <h2 className="mb-3 text-lg font-semibold">Paper groups</h2>
      <form onSubmit={submit} className="mb-4 space-y-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" />
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as PaperGroupKind)}>
            <option value="cluster">Cluster</option>
            <option value="survey">Survey</option>
          </select>
          <button className="btn-secondary">Create</button>
        </div>
        <div className="grid max-h-32 gap-1 overflow-auto rounded-md bg-ink-50 p-2 dark:bg-ink-800 sm:grid-cols-2">
          {papers.map((paper) => (
            <label key={paper.id} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={selected.has(paper.id)} onChange={() => toggle(paper.id)} />
              <span className="truncate">{paper.title}</span>
            </label>
          ))}
        </div>
      </form>
      <div className="space-y-3">
        {groups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            papers={papers}
            expanded={expanded === group.id}
            onToggleExpand={() => setExpanded((current) => (current === group.id ? null : group.id))}
            onStartRevision={() => startRevision(group)}
            onDelete={() => user && deletePaperGroup(user.uid, group.id)}
          />
        ))}
        {groups.length === 0 ? <p className="text-sm text-ink-500">No groups yet — select papers above to cluster them for combined revision.</p> : null}
      </div>
    </section>
  );
}

function GroupRow({
  group,
  papers,
  expanded,
  onToggleExpand,
  onStartRevision,
  onDelete
}: {
  group: PaperGroup;
  papers: Paper[];
  expanded: boolean;
  onToggleExpand: () => void;
  onStartRevision: () => void;
  onDelete: () => void;
}) {
  const groupPapers = papers.filter((paper) => group.paperIds.includes(paper.id));
  const sharedCitations = expanded ? computeSharedCitations(groupPapers, papers) : [];
  const repeatedAuthors = expanded ? computeRepeatedAuthors(groupPapers) : [];

  return (
    <div className="rounded-md border border-ink-200 p-3 dark:border-ink-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button className="text-left font-medium hover:underline" onClick={onToggleExpand}>
          {group.name} <span className="text-xs text-ink-500">({group.kind}, {group.paperIds.length} papers)</span>
        </button>
        <div className="flex items-center gap-2">
          {!group.revisionItemId ? (
            <button className="btn-secondary py-1 text-xs" onClick={onStartRevision}>
              Start revision
            </button>
          ) : (
            <span className="text-xs text-moss-700 dark:text-moss-400">In /review queue</span>
          )}
          <button className="text-ink-400 hover:text-red-600" onClick={onDelete} aria-label="Delete group">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="mt-3 space-y-2 text-sm">
          {group.lastSynthesis ? (
            <p className="rounded-md bg-moss-600/5 p-2 text-xs">
              Last synthesis ({group.lastSynthesis.at.slice(0, 10)}): {group.lastSynthesis.text}
            </p>
          ) : null}
          {sharedCitations.length > 0 ? (
            <div>
              <p className="label mb-1">Shared citations</p>
              {sharedCitations.slice(0, 5).map((citation) => (
                <p key={citation.ref} className="text-xs text-ink-600 dark:text-ink-300">
                  {citation.citedByPaperIds.length} of {groupPapers.length} papers cite &ldquo;{citation.ref}&rdquo;
                  {!citation.inLibrary ? <span className="ml-1 text-amber-700 dark:text-amber-400">— not in your library</span> : null}
                </p>
              ))}
            </div>
          ) : null}
          {repeatedAuthors.length > 0 ? (
            <div>
              <p className="label mb-1">Repeated authors</p>
              <p className="text-xs text-ink-600 dark:text-ink-300">{repeatedAuthors.map((author) => author.name).join(", ")}</p>
            </div>
          ) : null}
          {sharedCitations.length === 0 && repeatedAuthors.length === 0 ? (
            <p className="text-xs text-ink-500">No shared citations or repeated authors yet — fill in Pass 1&apos;s references-read and Pass 2&apos;s unread-references fields for these papers.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
