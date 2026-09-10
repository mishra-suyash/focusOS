"use client";

import { ArrowUpRight, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { createPaperNote, createTask, deletePaperNote, subscribePaperNotes } from "@/lib/firestore";
import type { PaperNote, PaperNoteKind } from "@/types";

const NOTE_KINDS: PaperNoteKind[] = ["quote", "idea", "question", "critique", "todo"];

export function PaperNotesPanel({ paperId }: { paperId: string }) {
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
    await createPaperNote(user.uid, paperId, { paperId, kind, body: body.trim() });
    setBody("");
  }

  async function promote(note: PaperNote) {
    if (!user) return;
    await createTask(user.uid, { title: note.body, status: "todo", priority: "medium", category: "reading" });
    await deletePaperNote(user.uid, paperId, note.id);
  }

  return (
    <div>
      <form onSubmit={submit} className="mb-3 grid grid-cols-[120px_1fr_auto] gap-2">
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
      <div className="space-y-2">
        {notes.map((note) => (
          <div key={note.id} className="flex items-start justify-between gap-2 rounded-md border border-ink-200 p-2 text-sm dark:border-ink-800">
            <div>
              <span className="mr-2 rounded bg-ink-50 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                {note.kind}
              </span>
              {note.body}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {note.kind === "todo" ? (
                <button className="text-ink-400 hover:text-moss-700" onClick={() => promote(note)} aria-label="Promote to task">
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
