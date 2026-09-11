"use client";

import Link from "next/link";
import { Info, Sparkle } from "lucide-react";
import { SectionHeader } from "@/components/section-header";
import { RENAMES } from "@/components/vocabulary-rename-dialog";
import { useFeatures } from "@/hooks/use-features";
import type { ModuleId } from "@/lib/features";

// Content copy of components/app-shell.tsx's NAV_ITEMS (one-line descriptions instead of icons) —
// keep the href/moduleId list here in sync with that one when nav destinations change.
const DESTINATIONS: { href: string; label: string; description: string; moduleId?: ModuleId }[] = [
  { href: "/dashboard", label: "Today", description: "Your day at a glance — up next, tasks, focus timer, Workload." },
  { href: "/tasks", label: "Tasks", description: "Everything you need to get done. Filter by Today, This week, Upcoming, or Completed." },
  { href: "/plan/day", label: "Plan", description: "Your day, block by block — templates live here, and a Calendar tab shows the month." },
  { href: "/papers", label: "Papers", description: "Papers you want to read, are reading, or have read. Skim / Read / Deep dive." },
  { href: "/courses", label: "Courses", description: "Your classes, assessments, and what each lecture covered.", moduleId: "courses" },
  { href: "/review", label: "Revise", description: "Topics and papers come back at growing intervals as you revise them.", moduleId: "revise" },
  { href: "/goals", label: "Goals", description: "Long-term aims like a chapter, an exam, or a submission.", moduleId: "goals" },
  { href: "/reviews/daily", label: "Daily wrap-up", description: "Close out the day and carry things over to tomorrow." },
  { href: "/reviews/weekly", label: "Weekly check-in", description: "A short weekly review of long-running goals.", moduleId: "weeklyCheckin" },
  { href: "/analytics", label: "Analytics", description: "Trends across tasks, focus sessions, and load.", moduleId: "analytics" },
  { href: "/insights", label: "AI Insights", description: "AI-generated daily insight summaries.", moduleId: "insights" }
];

/** Plan §11.2's U6 row — a short in-app orientation page, not a full manual. Destinations are
 * filtered to modules the reader actually has on, so this never lists something they can't open. */
export default function HelpPage() {
  const { isEnabled } = useFeatures();
  const destinations = DESTINATIONS.filter((item) => !item.moduleId || isEnabled(item.moduleId));

  return (
    <>
      <SectionHeader title="Help" eyebrow="A quick orientation" />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 text-lg font-semibold">The daily loop</h2>
          <ol className="space-y-3 text-sm text-ink-600 dark:text-ink-300">
            <li>
              <span className="font-medium text-ink-950 dark:text-ink-50">Start day</span> — builds today&apos;s plan from your
              workday template and turns on hydration/break reminders. Click it from the header.
            </li>
            <li>
              <span className="font-medium text-ink-950 dark:text-ink-50">Work the plan</span> — the Today page always shows
              what&apos;s Up next; Tasks, Plan, and the focus timer handle the rest.
            </li>
            <li>
              <span className="font-medium text-ink-950 dark:text-ink-50">End day</span> — closes today&apos;s session and opens
              the Daily wrap-up. Clicked by accident? A 10-second Undo toast appears in the corner.
            </li>
          </ol>
          <p className="mt-4 text-xs text-ink-500">
            Left a tab open overnight? A banner appears at the top once the date has actually moved on — nothing changes
            underneath you without warning.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-lg font-semibold">Where things live</h2>
          <ul className="space-y-2.5 text-sm">
            {destinations.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="font-medium text-moss-700 hover:underline dark:text-moss-400">
                  {item.label}
                </Link>
                <span className="text-ink-500"> — {item.description}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <Sparkle className="h-4 w-4 text-moss-600" />
            Turning features on or off
          </h2>
          <p className="text-sm text-ink-600 dark:text-ink-300">
            Courses, Revise, Goals, Weekly check-in, Workload, and Analytics are optional — most packs start with only some
            of them on. Turn any of them on or off any time, without losing anything already saved.
          </p>
          <Link href="/settings/features" className="btn-secondary mt-3 py-1.5 text-xs">
            Manage features
          </Link>
          <p className="mt-3 text-xs text-ink-500">
            FocusOS also nudges you toward a feature when what you&apos;re doing suggests it&apos;d help — at most one
            suggestion a day, and each only shown once.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <Info className="h-4 w-4 text-moss-600" />
            The ⓘ icons
          </h2>
          <p className="text-sm text-ink-600 dark:text-ink-300">
            Any label with a small <Info className="inline h-3.5 w-3.5 align-text-bottom" /> next to it has a one-line
            explanation behind it — click to open, click away to close.
          </p>
        </section>
      </div>

      <section className="card mt-6 p-5">
        <h2 className="mb-1 text-lg font-semibold">Words we use</h2>
        <p className="mb-4 text-sm text-ink-500">
          FocusOS renamed a few things to be plainer. Nothing about how it works changed — just the words for it.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {RENAMES.map((item) => (
            <div key={item.was} className="rounded-md bg-ink-50 p-2.5 text-sm dark:bg-ink-800">
              <p>
                <span className="text-ink-400 line-through">{item.was}</span>{" "}
                <span className="font-medium text-moss-700 dark:text-moss-400">→ {item.now}</span>
              </p>
              {item.hint ? <p className="mt-0.5 text-xs text-ink-500">{item.hint}</p> : null}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
