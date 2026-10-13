"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useUserSettings } from "@/hooks/use-user-settings";
import { DEFAULT_READING_HABIT } from "@/lib/papers";
import { DEFAULT_MAX_CHUNK_MINUTES, DEFAULT_MIN_CHUNK_MINUTES } from "@/lib/timeline";
import type { ReadingHabit, UserSettings } from "@/types";

/**
 * plan/17 §5.1/§9 — the reading habit's defaults (each week can change its own in weekly planning,
 * Step 3) and the sources a "Find a paper" sitting opens.
 */
export function ReadingHabitSettings() {
  const { settings, update } = useUserSettings();
  const habit: NonNullable<UserSettings["readingHabit"]> = settings.readingHabit ?? DEFAULT_READING_HABIT;
  const sources = habit.sources ?? [];
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const minChunk = settings.minChunkMinutes ?? DEFAULT_MIN_CHUNK_MINUTES;
  const maxChunk = settings.maxChunkMinutes ?? DEFAULT_MAX_CHUNK_MINUTES;

  function save(patch: Partial<ReadingHabit> & { sources?: { label: string; url: string }[] }) {
    update({ readingHabit: { ...habit, ...patch } });
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-lg font-semibold">Reading</h2>
      <p className="mb-3 text-xs text-ink-500">
        Your weekly reading habit. Weekly planning places these sittings every week, whether or not a paper is ready — you pick what to
        read when a sitting starts. {settings.readingHabit ? "" : `Not set yet, so the default (${DEFAULT_READING_HABIT.sittings} × ${DEFAULT_READING_HABIT.minutes} min) is used.`}
      </p>
      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Sittings a week</span>
          <input
            className="input w-24"
            type="number"
            min={0}
            max={14}
            value={habit.sittings}
            onChange={(e) => save({ sittings: Math.max(0, Math.min(14, Math.round(Number(e.target.value)))) })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Minutes per sitting</span>
          <input
            className="input w-24"
            type="number"
            min={minChunk}
            max={maxChunk}
            step={5}
            value={habit.minutes}
            onChange={(e) => save({ minutes: Math.max(minChunk, Math.min(maxChunk, Math.round(Number(e.target.value)))) })}
          />
        </label>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Preferred time</span>
          <select className="input w-36" value={habit.timeOfDay ?? ""} onChange={(e) => save({ timeOfDay: (e.target.value || undefined) as ReadingHabit["timeOfDay"] })}>
            <option value="">Any time</option>
            <option value="morning">Mornings</option>
            <option value="afternoon">Afternoons</option>
            <option value="evening">Evenings</option>
          </select>
        </label>
        <div>
          <p className="text-sm">Where you look for papers</p>
          <p className="mb-2 text-xs text-ink-500">Opened by a &ldquo;Find a paper&rdquo; sitting — arXiv listings, a lab page, a reading group&apos;s list.</p>
          <div className="space-y-1">
            {sources.map((source, index) => (
              <div key={`${source.url}:${index}`} className="flex items-center gap-2 text-xs">
                <a href={source.url} target="_blank" rel="noreferrer" className="flex-1 truncate underline">
                  {source.label}
                </a>
                <button className="text-ink-400 hover:text-red-600" aria-label={`Remove ${source.label}`} onClick={() => save({ sources: sources.filter((_, i) => i !== index) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input className="input w-32 py-1 text-xs" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name" />
            <input className="input flex-1 py-1 text-xs" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://arxiv.org/list/cs.LG/recent" />
            <button
              className="btn-secondary px-2 py-1 text-xs"
              disabled={!/^https?:\/\//.test(url.trim())}
              onClick={() => {
                save({ sources: [...sources, { label: label.trim() || url.trim(), url: url.trim() }] });
                setLabel("");
                setUrl("");
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
