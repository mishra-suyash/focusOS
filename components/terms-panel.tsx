"use client";

import { orderBy } from "firebase/firestore";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { createTerm, deleteTerm } from "@/lib/firestore";
import type { NewTerm, Term, TermKind } from "@/types";

/**
 * plan/14 §8 — moved off `/courses` ("a term is configured twice a year; it does not belong above
 * the course list every single visit") onto `/settings`, unchanged otherwise. Self-contained (owns
 * its own `terms` subscription) so it can be dropped into Settings without prop-drilling from the
 * course page that used to host it.
 */
export function TermsPanel() {
  const { user } = useAuth();
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TermKind>("semester");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!user || !name.trim() || !startDate || !endDate) return;
    const term: NewTerm = { name: name.trim(), kind, startDate, endDate };
    await createTerm(user.uid, term);
    setName("");
    setStartDate("");
    setEndDate("");
  }

  return (
    <section id="term-add" className="card p-5">
      <h2 className="mb-3 text-lg font-semibold">Terms</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        {terms.map((term) => (
          <span key={term.id} className="flex items-center gap-2 rounded-md bg-ink-50 px-2.5 py-1.5 text-xs dark:bg-ink-800">
            <span className="font-medium">{term.name}</span>
            <span className="text-ink-500">
              {term.kind} · {term.startDate} to {term.endDate}
            </span>
            <button className="text-ink-400 hover:text-red-600" onClick={() => user && deleteTerm(user.uid, term.id)} aria-label="Delete term">
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        ))}
        {terms.length === 0 ? <p className="text-sm text-ink-500">No terms yet — courses without a term are always treated as active.</p> : null}
      </div>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_130px_150px_150px_auto]">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Term name (e.g. Sem 3)" />
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as TermKind)}>
          <option value="semester">Semester</option>
          <option value="break">Break</option>
          <option value="none">None</option>
        </select>
        <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        <button className="btn-secondary">Add term</button>
      </form>
    </section>
  );
}
