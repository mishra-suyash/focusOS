"use client";

import { ArrowUpRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { createPaperNote, createTask, deletePaperNote, subscribePaperNotes } from "@/lib/firestore";
import type { PaperNote, PaperNoteKind } from "@/types";

const NOTE_KINDS: PaperNoteKind[] = ["quote", "idea", "question", "critique", "todo"];

/**
 * `anchor` is supplied only when this panel is embedded in the reading window
 * (plan/12.FocusOS-v2-Paper-Reading-Window-Plan.md §7) — it sets `anchorPage`/
 * `anchorQuote` on notes created from there, closing the gap where those fields
 * existed on `PaperNote` but nothing ever set them. `onJump` makes an already-
 * anchored note clickable to jump back to its page, the same way an annotation is.
 */
export function PaperNotesPanel({
  paperId,
  anchor,
  onJump,
  onAdded,
  compact = false
}: {
  paperId: string;
  anchor?: { page: number; quote?: string };
  onJump?: (page: number) => void;
  /** After a note is saved: the reader drops the highlight draft whose passage the note just took. */
  onAdded?: () => void;
  /** The reader's narrow sidebar: the form stacks instead of sitting on one row. */
  compact?: boolean;
}) {
  const { user } = useAuth();
  const [notes, setNotes] = useState<PaperNote[]>([]);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<PaperNoteKind>("idea");

  useEffect(() => {
    if (!user) return;
    return subscribePaperNotes(user.uid, paperId, setNotes);
  }, [user, paperId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user || !body.trim()) return;
    await createPaperNote(user.uid, paperId, {
      paperId,
      kind,
      body: body.trim(),
      anchorPage: anchor?.page,
      anchorQuote: anchor?.quote
    });
    setBody("");
    onAdded?.();
  }

  async function promote(note: PaperNote) {
    if (!user) return;
    await createTask(user.uid, { title: note.body, status: "todo", priority: "medium", category: "reading" });
    await deletePaperNote(user.uid, paperId, note.id);
  }

  return (
    <div>
      {anchor ? (
        <p className="mb-2 text-xs text-ink-500">
          New notes anchor to page {anchor.page}
          {anchor.quote ? <> and the selected quote</> : null}.
        </p>
      ) : null}
      {compact ? (
        <form onSubmit={submit} className="mb-3 space-y-2">
          <textarea
            className="input min-h-[4rem] text-xs"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the note, Shift+Enter starts a new line.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Add a note..."
            aria-label="Note"
          />
          <div className="flex gap-2">
            <select className="input py-1 text-xs" value={kind} onChange={(e) => setKind(e.target.value as PaperNoteKind)} aria-label="Note kind">
              {NOTE_KINDS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button className="btn-secondary shrink-0 px-3 py-1 text-xs" disabled={!body.trim()}>
              Add
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={submit} className="mb-3 grid gap-2 sm:grid-cols-[120px_1fr_auto]">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as PaperNoteKind)}>
            {NOTE_KINDS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note..." />
          <button className="btn-secondary">Add</button>
        </form>
      )}
      <div className="space-y-2">
        {notes.map((note) => (
          <div key={note.id} className={`flex items-start justify-between gap-2 rounded-md border border-ink-200 p-2 dark:border-ink-800 ${compact ? "text-xs" : "text-sm"}`}>
            <div className="min-w-0 break-words">
              <span className="mr-2 rounded bg-ink-50 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                {note.kind}
              </span>
              {note.body}
              {note.anchorPage ? (
                <button
                  className="ml-2 text-xs text-moss-700 hover:underline disabled:no-underline disabled:text-ink-400 dark:text-moss-400"
                  onClick={() => onJump?.(note.anchorPage!)}
                  disabled={!onJump}
                >
                  p.{note.anchorPage}
                </button>
              ) : null}
              {/* The passage the note was written against, which was saved but never shown. */}
              {note.anchorQuote ? <p className="mt-1 line-clamp-2 border-l-2 border-ink-200 pl-2 text-xs text-ink-500 dark:border-ink-700">&ldquo;{note.anchorQuote}&rdquo;</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {note.kind === "todo" ? (
                <button className="text-ink-400 hover:text-moss-700" onClick={() => promote(note)} aria-label="Promote to task" title="Promote to task">
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              ) : null}
              <button className="text-ink-400 hover:text-red-600" onClick={() => user && deletePaperNote(user.uid, paperId, note.id)} aria-label="Delete note">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
        {notes.length === 0 ? <p className="text-sm text-ink-500">No notes yet.</p> : null}
      </div>
    </div>
  );
}
