"use client";

import { orderBy } from "firebase/firestore";
import { Heart, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { createThought, deleteThought, updateThought } from "@/lib/firestore";
import type { Thought, ThoughtSourceType } from "@/types";

const sourceTypes: ThoughtSourceType[] = ["quote", "self_note", "principle", "reminder"];

export default function ThoughtsPage() {
  const { user } = useAuth();
  const { items: thoughts } = useUserCollection<Thought>("thoughts", useMemo(() => [orderBy("createdAt", "desc")], []));
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [category, setCategory] = useState("");
  const [sourceType, setSourceType] = useState<ThoughtSourceType>("self_note");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user || !text.trim()) return;
    await createThought(user.uid, {
      text: text.trim(),
      author: author.trim() || undefined,
      category: category.trim() || undefined,
      sourceType,
      isFavorite: false
    });
    setText("");
    setAuthor("");
    setCategory("");
    setSourceType("self_note");
  }

  return (
    <>
      <SectionHeader title="Thoughts" eyebrow="Quotes, principles, reminders" />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Add thought</h2>
          <form onSubmit={submit} className="space-y-3">
            <textarea className="input min-h-32" value={text} onChange={(event) => setText(event.target.value)} placeholder="A precise idea worth seeing again..." />
            <input className="input" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Author optional" />
            <input className="input" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Category optional" />
            <select className="input" value={sourceType} onChange={(event) => setSourceType(event.target.value as ThoughtSourceType)}>
              {sourceTypes.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}
            </select>
            <button className="btn-primary w-full">
              <Plus className="h-4 w-4" />
              Add thought
            </button>
          </form>
        </section>
        <section className="space-y-3">
          {thoughts.map((thought) => (
            <article key={thought.id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="leading-7">{thought.text}</p>
                  <p className="mt-2 text-sm text-ink-500">
                    {[thought.author, thought.category, thought.sourceType.replace("_", " ")].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button className="btn-secondary px-2" onClick={() => user && updateThought(user.uid, thought.id, { isFavorite: !thought.isFavorite })} aria-label="Toggle favorite">
                    <Heart className={`h-4 w-4 ${thought.isFavorite ? "fill-current text-red-600" : ""}`} />
                  </button>
                  <button className="btn-secondary px-2" onClick={() => user && deleteThought(user.uid, thought.id)} aria-label="Delete thought">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </article>
          ))}
          {thoughts.length === 0 ? <div className="card p-8 text-center text-sm text-ink-500">No thoughts yet. Add one to populate the dashboard widget.</div> : null}
        </section>
      </div>
    </>
  );
}
