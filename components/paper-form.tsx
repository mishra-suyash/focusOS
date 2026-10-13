"use client";

import { useState } from "react";
import { MoreOptions } from "@/components/more-options";
import { priorities } from "@/lib/options";
import type { Course, NewPaper, Priority } from "@/types";

/** Plan §9.5 — Title and link always visible; authors, venue, year, tags, priority behind "More options". */
export function PaperForm({
  onCreate,
  courses = []
}: {
  onCreate: (paper: NewPaper) => Promise<void>;
  /** plan/10.FocusOS-v2-Connected-Flow-Plan.md §5.4 — wires up Paper.relatedCourseId, which existed in the type with no way to ever set it before this. */
  courses?: Course[];
}) {
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [venue, setVenue] = useState("");
  const [year, setYear] = useState("");
  const [link, setLink] = useState("");
  const [tags, setTags] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [relatedCourseId, setRelatedCourseId] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // plan/17 §5.6 — a link on its own is a capture: it goes to the inbox, titled by the link until
    // it's edited (no metadata lookup — plan/17 §13 Q4).
    const linkOnly = !title.trim() && Boolean(link.trim());
    if (!title.trim() && !linkOnly) return;
    setSaving(true);
    await onCreate({
      title: title.trim() || link.trim(),
      ...(linkOnly ? { inbox: true, source: { kind: "link" as const } } : {}),
      authors: authors.split(",").map((item) => item.trim()).filter(Boolean),
      venue: venue.trim() || undefined,
      year: year ? Number(year) : undefined,
      link: link.trim() || undefined,
      status: linkOnly ? "inbox" : "to_read",
      priority,
      tags: tags.split(",").map((item) => item.trim()).filter(Boolean),
      relatedCourseId: relatedCourseId || undefined
    });
    setTitle("");
    setAuthors("");
    setVenue("");
    setYear("");
    setLink("");
    setTags("");
    setRelatedCourseId("");
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Paper title" />
      <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link or DOI URL" />
      {!title.trim() && link.trim() ? <p className="-mt-1 text-xs text-ink-500">Just a link? It goes to your inbox to triage later.</p> : null}
      <MoreOptions>
        <input className="input" value={authors} onChange={(e) => setAuthors(e.target.value)} placeholder="Authors (comma separated)" />
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Venue (e.g. NeurIPS)" />
          <input className="input" type="number" value={year} onChange={(e) => setYear(e.target.value)} placeholder="Year" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Tags (comma separated)" />
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {priorities.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </div>
        {courses.length > 0 ? (
          <select className="input" value={relatedCourseId} onChange={(e) => setRelatedCourseId(e.target.value)} aria-label="Course">
            <option value="">— No course —</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.code ? `${course.code} · ${course.name}` : course.name}
              </option>
            ))}
          </select>
        ) : null}
      </MoreOptions>
      <button className="btn-primary w-full sm:w-auto" disabled={saving}>
        {!title.trim() && link.trim() ? "Add to inbox" : "Add to reading list"}
      </button>
    </form>
  );
}
