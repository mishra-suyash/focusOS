"use client";

import { Heart, Plus, Shuffle } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { createThought, saveThoughtSelection, updateThought } from "@/lib/firestore";
import { stableThoughtForDate } from "@/lib/schedule";
import type { Thought, ThoughtSelection } from "@/types";

export function ThoughtWidget({
  thoughts,
  selection,
  dateKey,
  compact = false
}: {
  thoughts: Thought[];
  selection?: ThoughtSelection;
  dateKey: string;
  compact?: boolean;
}) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const selected = useMemo(() => {
    const override = thoughts.find((thought) => thought.id === selection?.thoughtId);
    return override ?? stableThoughtForDate(thoughts, dateKey);
  }, [dateKey, selection, thoughts]);

  async function nextThought() {
    if (!user || thoughts.length === 0) return;
    const currentIndex = Math.max(0, thoughts.findIndex((thought) => thought.id === selected?.id));
    const next = thoughts[(currentIndex + 1) % thoughts.length];
    await saveThoughtSelection(user.uid, { dateKey, thoughtId: next.id });
  }

  async function addThought(event: React.FormEvent) {
    event.preventDefault();
    if (!user || !text.trim()) return;
    await createThought(user.uid, { text: text.trim(), sourceType: "self_note", isFavorite: false });
    setText("");
  }

  return (
    <section className={`card ${compact ? "p-4" : "p-5"}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="label">Thought of the day</p>
          <h2 className="mt-1 text-lg font-semibold">A small anchor</h2>
        </div>
        <Link href="/thoughts" className="btn-secondary py-1.5">
          Manage
        </Link>
      </div>
      {selected ? (
        <blockquote className="rounded-md border-l-4 border-moss-600 bg-ink-50 p-3 dark:bg-ink-800">
          <p className={`${compact ? "max-h-24 overflow-hidden text-sm leading-6" : "text-base leading-7"}`}>&quot;{selected.text}&quot;</p>
          {selected.author || selected.category ? (
            <footer className="mt-3 text-sm text-ink-500">
              {selected.author ? selected.author : selected.category}
            </footer>
          ) : null}
        </blockquote>
      ) : (
        <div className="rounded-md border border-dashed border-ink-300 p-4 text-sm text-ink-500 dark:border-ink-700">
          Add a quote, principle, or self-note to start the daily rotation.
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-secondary" onClick={nextThought} disabled={thoughts.length === 0}>
          <Shuffle className="h-4 w-4" />
          Next thought
        </button>
        <button className="btn-secondary" onClick={() => selected && user && updateThought(user.uid, selected.id, { isFavorite: !selected.isFavorite })} disabled={!selected}>
          <Heart className={`h-4 w-4 ${selected?.isFavorite ? "fill-current text-red-600" : ""}`} />
          {selected?.isFavorite ? "Unfavorite" : "Favorite"}
        </button>
      </div>
      {compact ? null : (
        <form onSubmit={addThought} className="mt-4 flex gap-2">
          <input className="input" value={text} onChange={(event) => setText(event.target.value)} placeholder="Add a thought..." />
          <button className="btn-primary px-3" aria-label="Add thought">
            <Plus className="h-4 w-4" />
          </button>
        </form>
      )}
    </section>
  );
}
