"use client";

import { clsx } from "clsx";
import { orderBy } from "firebase/firestore";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSaveTerm, type TermEdit } from "@/hooks/use-save-term";
import { useUserCollection } from "@/hooks/use-user-collection";
import { scheduleDayKey } from "@/lib/dates";
import { coursesFollowingTerm } from "@/lib/term-change";
import {
  endDateForWeeks,
  formatTermDate,
  getActiveTerm,
  overlappingTerms,
  termFormErrors,
  termKindLabels,
  termLengthDays,
  termLengthLabel
} from "@/lib/terms";
import type { Course, NewTerm, Term, TermKind } from "@/types";

const kindStyles: Record<TermKind, string> = {
  semester: "bg-moss-600/10 text-moss-700 dark:text-moss-300",
  break: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  none: "bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300"
};

/**
 * plan/14 §8 — lives on `/settings`, not above the course list. Self-contained (owns its own `terms`
 * subscription) so it can be dropped into Settings without prop-drilling. Every save goes through
 * `useSaveTerm`, which carries the dates on to the courses and saved days that copied them.
 */
export function TermsPanel() {
  const { items: terms } = useUserCollection<Term>("terms", useMemo(() => [orderBy("startDate", "desc")], []));
  const { items: courses } = useUserCollection<Course>("courses", useMemo(() => [orderBy("createdAt", "desc")], []));
  const saveTerm = useSaveTerm();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const today = scheduleDayKey();
  const current = getActiveTerm(terms, today);

  // "Add a term" links elsewhere in the app land here; open the form rather than leave them to find it.
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === "#term-add") setAdding(true);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  async function save(edit: TermEdit) {
    await saveTerm(edit);
    setAdding(false);
    setEditingId(null);
    setDeletingId(null);
  }

  return (
    <section id="term-add" className="card scroll-mt-20 p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Terms</h2>
        {!adding ? (
          <button className="btn-secondary py-1.5 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add term
          </button>
        ) : null}
      </div>
      <p className="mb-4 text-xs text-ink-500">
        Classes show on days a semester covers. On a break, or a day no term covers, they don&apos;t.
        {terms.length > 0 && !current ? " No term covers today." : ""}
      </p>

      {adding ? (
        <div className="mb-3 rounded-md border border-ink-200 p-3 dark:border-ink-700">
          <TermForm terms={terms} courses={courses} submitLabel="Add term" onCancel={() => setAdding(false)} onSave={(term) => save({ kind: "add", term })} />
        </div>
      ) : null}

      {terms.length === 0 && !adding ? <p className="text-sm text-ink-500">No terms yet. Courses without a term are always treated as active.</p> : null}

      <ul className="space-y-2">
        {terms.map((term) => {
          const linked = courses.filter((course) => course.termId === term.id);
          if (editingId === term.id) {
            return (
              <li key={term.id} className="rounded-md border border-moss-500 p-3">
                <TermForm term={term} terms={terms} courses={courses} submitLabel="Save" onCancel={() => setEditingId(null)} onSave={(next) => save({ kind: "edit", id: term.id, term: next })} />
              </li>
            );
          }
          return (
            <li key={term.id} className="rounded-md border border-ink-200 p-3 dark:border-ink-700">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {term.name}
                    <span className={clsx("rounded px-1.5 py-0.5 text-[11px] font-medium", kindStyles[term.kind])}>{termKindLabels[term.kind]}</span>
                    {current?.id === term.id ? <span className="rounded bg-ink-900 px-1.5 py-0.5 text-[11px] font-medium text-white dark:bg-ink-100 dark:text-ink-900">Current</span> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {formatTermDate(term.startDate)} – {formatTermDate(term.endDate)} · {termLengthLabel(term.startDate, term.endDate)}
                  </p>
                  {linked.length > 0 ? <p className="mt-0.5 truncate text-xs text-ink-500">Courses: {linked.map((course) => course.code ?? course.name).join(", ")}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    className="rounded p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800 dark:hover:bg-ink-800 dark:hover:text-ink-100"
                    onClick={() => {
                      setEditingId(term.id);
                      setDeletingId(null);
                    }}
                    aria-label={`Edit ${term.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="rounded p-1.5 text-ink-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                    onClick={() => setDeletingId(term.id)}
                    aria-label={`Delete ${term.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {deletingId === term.id ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-red-50 px-2.5 py-2 text-xs text-red-800 dark:bg-red-950/50 dark:text-red-200">
                  <span>
                    Delete &ldquo;{term.name}&rdquo;?{term.kind === "semester" ? " Its classes come off saved days that only it covered." : ""}
                  </span>
                  <span className="flex gap-2">
                    <button className="font-medium hover:underline" onClick={() => save({ kind: "delete", id: term.id })}>
                      Delete
                    </button>
                    <button className="hover:underline" onClick={() => setDeletingId(null)}>
                      Cancel
                    </button>
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TermForm({
  term,
  terms,
  courses,
  submitLabel,
  onSave,
  onCancel
}: {
  term?: Term;
  terms: Term[];
  courses: Course[];
  submitLabel: string;
  onSave: (term: NewTerm) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<NewTerm>({
    name: term?.name ?? "",
    kind: term?.kind ?? "semester",
    startDate: term?.startDate ?? "",
    endDate: term?.endDate ?? ""
  });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = termFormErrors(draft);
  const datesReady = Boolean(draft.startDate && draft.endDate && draft.endDate >= draft.startDate);
  const days = datesReady ? termLengthDays(draft.startDate, draft.endDate) : 0;
  const overlaps = datesReady ? overlappingTerms(terms, draft, term?.id) : [];
  const following = term && datesReady ? coursesFollowingTerm(courses, term, draft) : [];
  const ownDates = term && following.length > 0 ? courses.filter((course) => course.termId === term.id && !following.some((patch) => patch.item.id === course.id)) : [];
  const set = (patch: Partial<NewTerm>) => setDraft((current) => ({ ...current, ...patch }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setTried(true);
    if (errors.length > 0) return;
    setSaving(true);
    try {
      await onSave({ ...draft, name: draft.name.trim() });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <label className="text-xs text-ink-500">
          Name
          <input className="input mt-1" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Sem 3" autoFocus />
        </label>
        <label className="text-xs text-ink-500">
          Kind
          <select className="input mt-1" value={draft.kind} onChange={(e) => set({ kind: e.target.value as TermKind })}>
            <option value="semester">Semester</option>
            <option value="break">Break</option>
            <option value="none">Other</option>
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_110px]">
        <label className="text-xs text-ink-500">
          Starts
          <input className="input mt-1" type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
        </label>
        <label className="text-xs text-ink-500">
          Ends
          <input className="input mt-1" type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={(e) => set({ endDate: e.target.value })} />
        </label>
        <label className="text-xs text-ink-500">
          Weeks
          <input
            className="input mt-1"
            type="number"
            min={1}
            max={104}
            disabled={!draft.startDate}
            value={days > 0 && days % 7 === 0 ? days / 7 : ""}
            placeholder={days > 0 ? (days / 7).toFixed(1) : ""}
            onChange={(e) => {
              const weeks = Math.round(Number(e.target.value));
              if (draft.startDate && weeks >= 1) set({ endDate: endDateForWeeks(draft.startDate, weeks) });
            }}
          />
        </label>
      </div>
      {datesReady ? <p className="text-xs text-ink-500">{termLengthLabel(draft.startDate, draft.endDate)}, {formatTermDate(draft.startDate)} to {formatTermDate(draft.endDate)}.</p> : null}
      {draft.kind !== "semester" ? <p className="text-xs text-ink-500">No class blocks on these days.</p> : null}
      {overlaps.length > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Shares days with {overlaps.map((other) => `“${other.name}”`).join(", ")}. On those days the term that starts later counts.
        </p>
      ) : null}
      {following.length > 0 ? (
        <p className="text-xs text-ink-600 dark:text-ink-300">
          {following.map((patch) => patch.item.code ?? patch.item.name).join(", ")} {following.length === 1 ? "moves" : "move"} with these dates.
          {ownDates.length > 0 ? ` ${ownDates.map((course) => course.code ?? course.name).join(", ")} ${ownDates.length === 1 ? "keeps its" : "keep their"} own dates.` : ""}
        </p>
      ) : null}
      {tried && errors.length > 0 ? <p className="text-xs text-red-600 dark:text-red-400">{errors.join(" ")}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary py-1.5 text-xs" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-primary py-1.5 text-xs" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
