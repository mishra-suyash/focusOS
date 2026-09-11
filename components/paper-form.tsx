"use client";

import { useState } from "react";
import { MoreOptions } from "@/components/more-options";
import { priorities } from "@/lib/options";
import type { NewPaper, Priority } from "@/types";

/** Plan §9.5 — Title and link always visible; authors, venue, year, tags, priority behind "More options". */
export function PaperForm({ onCreate }: { onCreate: (paper: NewPaper) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [venue, setVenue] = useState("");
  const [year, setYear] = useState("");
  const [link, setLink] = useState("");
  const [tags, setTags] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    await onCreate({
      title: title.trim(),
      authors: authors.split(",").map((item) => item.trim()).filter(Boolean),
      venue: venue.trim() || undefined,
      year: year ? Number(year) : undefined,
      link: link.trim() || undefined,
      status: "to_read",
      priority,
      tags: tags.split(",").map((item) => item.trim()).filter(Boolean)
    });
    setTitle("");
    setAuthors("");
    setVenue("");
    setYear("");
    setLink("");
    setTags("");
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Paper title" />
      <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link or DOI URL" />
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
      </MoreOptions>
      <button className="btn-primary w-full sm:w-auto" disabled={saving}>
        Add to reading list
      </button>
    </form>
  );
}
