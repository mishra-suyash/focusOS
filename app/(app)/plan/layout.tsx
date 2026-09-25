"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

const TABS = [
  { href: "/plan/week", label: "Week" },
  { href: "/plan/day", label: "Day" },
  { href: "/plan/calendar", label: "Calendar" }
];

/** Plan (plan §9.3) — merges the old Day Planner and Calendar destinations into one nav concept, tabbed. Both routes keep working as deep links (old /planner/day and /calendar URLs redirect here — see next.config.mjs). */
export default function PlanLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-ink-200 dark:border-ink-800">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={clsx(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
              pathname.startsWith(tab.href) ? "border-moss-600 text-moss-700 dark:text-moss-400" : "border-transparent text-ink-500 hover:text-ink-800 dark:hover:text-ink-200"
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      {children}
    </div>
  );
}
