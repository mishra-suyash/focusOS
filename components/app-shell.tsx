"use client";

import {
  BarChart3,
  BookOpen,
  BrainCircuit,
  CalendarClock,
  CheckSquare,
  ChevronDown,
  ClipboardList,
  Flag,
  GraduationCap,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Moon,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { useTheme } from "@/components/theme-provider";
import { DaySessionBar } from "@/components/day-session-bar";
import { useFeatures } from "@/hooks/use-features";
import type { ModuleId } from "@/lib/features";
import { MidnightRolloverBanner } from "@/components/midnight-rollover-banner";
import { ReminderBanner } from "@/components/reminder-banner";
import { StartDayNoticeBanner } from "@/components/start-day-notice-banner";
import { UsageOverlay } from "@/components/usage-overlay";
import { clsx } from "clsx";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Absent = always shown (core). Present = filtered by useFeatures().isEnabled. */
  moduleId?: ModuleId;
  group: "primary" | "more";
}

/**
 * Plan §9.3's nav table (literal): Today/Tasks/Plan/Papers are always
 * primary (core modules); Courses/Revise/Goals are primary only when their
 * module is on, hidden (not demoted to More) when it's off. Note this gives
 * a Research-pack user 6 primary items (core 4 + Revise + Goals), not the 5
 * §9.8's acceptance criterion states — that criterion appears to be
 * inconsistent with §9.3's own table rather than derivable from it; §9.3 is
 * the more specific, authoritative source, so its table wins here and the
 * discrepancy is left for a human to resolve rather than silently
 * reinterpreted (e.g. by demoting Goals to More, which §9.3 explicitly
 * doesn't do for any pack). Daily/Weekly wrap-up and Analytics/Insights live
 * in the More group. Settings is rendered separately, pinned as a footer
 * item, and `workload` has no nav row at all — it's a dashboard widget, not
 * a destination.
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Today", icon: LayoutDashboard, group: "primary" },
  { href: "/tasks", label: "Tasks", icon: CheckSquare, group: "primary" },
  { href: "/plan/day", label: "Plan", icon: CalendarClock, group: "primary" },
  { href: "/papers", label: "Papers", icon: BookOpen, group: "primary" },
  { href: "/courses", label: "Courses", icon: GraduationCap, moduleId: "courses", group: "primary" },
  { href: "/review", label: "Revise", icon: BrainCircuit, moduleId: "revise", group: "primary" },
  { href: "/goals", label: "Goals", icon: Flag, moduleId: "goals", group: "primary" },
  { href: "/reviews/daily", label: "Daily wrap-up", icon: ClipboardList, group: "more" },
  { href: "/reviews/weekly", label: "Weekly check-in", icon: ClipboardList, moduleId: "weeklyCheckin", group: "more" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, moduleId: "analytics", group: "more" },
  { href: "/insights", label: "AI Insights", icon: Sparkles, moduleId: "insights", group: "more" }
];

const SETTINGS_ITEM: NavItem = { href: "/settings", label: "Settings", icon: Settings, group: "primary" };
const HELP_ITEM: NavItem = { href: "/help", label: "Help", icon: HelpCircle, group: "primary" };

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      className={clsx(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium outline-none transition focus:ring-2 focus:ring-moss-500",
        active ? "bg-moss-600 text-white" : "text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"
      )}
    >
      <Icon className="h-4 w-4" />
      {item.label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, role, logOut, loading, isDemoMode } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { isEnabled } = useFeatures();
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    fetch("/api/public/sign-in-methods")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setMaintenanceMode(Boolean(data?.maintenanceMode)))
      .catch(() => undefined);
  }, []);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-500">Loading FocusOS...</div>;
  }

  if (!user) return null;

  const visible = NAV_ITEMS.filter((item) => !item.moduleId || isEnabled(item.moduleId));
  const primaryItems = visible.filter((item) => item.group === "primary");
  const moreItems = visible.filter((item) => item.group === "more");
  const adminItem = role === "owner" || role === "admin" ? { href: "/admin", label: "Admin", icon: ShieldCheck, group: "primary" as const } : null;
  const allFlatItems = [...primaryItems, ...moreItems, SETTINGS_ITEM, HELP_ITEM, ...(adminItem ? [adminItem] : [])];

  return (
    <div className="min-h-screen bg-ink-50 text-ink-950 dark:bg-ink-950 dark:text-ink-50">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-ink-200 bg-white p-4 dark:border-ink-800 dark:bg-ink-900 lg:flex">
        <Link href="/dashboard" className="flex items-center gap-3 px-2 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-moss-600 font-bold text-white">F</span>
          <div>
            <p className="text-base font-semibold">FocusOS</p>
            <p className="text-xs text-ink-500 dark:text-ink-400">Research command center</p>
          </div>
        </Link>
        <nav className="mt-8 flex-1 space-y-1">
          {primaryItems.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} />
          ))}
          {moreItems.length > 0 ? (
            <div className="pt-1">
              <button
                className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-ink-500 outline-none transition hover:bg-ink-100 focus:ring-2 focus:ring-moss-500 dark:text-ink-400 dark:hover:bg-ink-800"
                onClick={() => setMoreOpen((current) => !current)}
              >
                More
                <ChevronDown className={clsx("h-4 w-4 transition-transform", moreOpen && "rotate-180")} />
              </button>
              {moreOpen ? (
                <div className="mt-1 space-y-1">
                  {moreItems.map((item) => (
                    <NavLink key={item.href} item={item} pathname={pathname} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {adminItem ? <NavLink item={adminItem} pathname={pathname} /> : null}
        </nav>
        <div className="border-t border-ink-200 pt-2 dark:border-ink-800">
          <NavLink item={SETTINGS_ITEM} pathname={pathname} />
          <NavLink item={HELP_ITEM} pathname={pathname} />
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-ink-800 dark:bg-ink-900/90">
          <div className="flex items-center justify-between gap-3">
            <nav className="flex gap-1 overflow-x-auto lg:hidden">
              {allFlatItems.map((item) => (
                <Link key={item.href} href={item.href} className="btn-secondary whitespace-nowrap px-2 py-1.5 text-xs">
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {isDemoMode ? (
                <span className="rounded-md bg-amberline/15 px-2 py-1 text-xs font-medium text-amberline">Env needed</span>
              ) : null}
              <DaySessionBar />
              <button className="btn-secondary px-2" onClick={toggleTheme} aria-label="Toggle dark mode">
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              <div className="hidden text-right sm:block">
                <p className="text-sm font-medium">{user.displayName ?? (user.isAnonymous ? "Guest" : "FocusOS Scholar")}</p>
                <p className="text-xs text-ink-500 dark:text-ink-400">{user.email || "Guest session"}</p>
              </div>
              <button className="btn-secondary px-2" onClick={logOut} aria-label="Sign out">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>
        {maintenanceMode ? (
          <div className="border-b border-amberline/30 bg-amberline/10 px-4 py-2 text-center text-xs font-medium text-ink-700 dark:text-ink-200">
            FocusOS is in maintenance mode. Some features may be limited.
          </div>
        ) : null}
        <MidnightRolloverBanner />
        <ReminderBanner />
        <StartDayNoticeBanner />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
      <UsageOverlay />
    </div>
  );
}
