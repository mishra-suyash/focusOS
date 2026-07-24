"use client";

import {
  BarChart3,
  CalendarDays,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  Lightbulb,
  LayoutDashboard,
  LogOut,
  Moon,
  Settings,
  Sun
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useTheme } from "@/components/theme-provider";
import { clsx } from "clsx";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/planner", label: "Planner", icon: CalendarDays },
  { href: "/planner/day", label: "Day Plan", icon: CalendarClock },
  { href: "/reviews/daily", label: "Daily Review", icon: ClipboardList },
  { href: "/reviews/weekly", label: "Weekly Review", icon: ClipboardList },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/thoughts", label: "Thoughts", icon: Lightbulb },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logOut, loading, isDemoMode } = useAuth();
  const { theme, toggleTheme } = useTheme();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-500">Loading FocusOS...</div>;
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-ink-50 text-ink-950 dark:bg-ink-950 dark:text-ink-50">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-ink-200 bg-white p-4 dark:border-ink-800 dark:bg-ink-900 lg:block">
        <Link href="/dashboard" className="flex items-center gap-3 px-2 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-moss-600 font-bold text-white">F</span>
          <div>
            <p className="text-base font-semibold">FocusOS</p>
            <p className="text-xs text-ink-500 dark:text-ink-400">Research command center</p>
          </div>
        </Link>
        <nav className="mt-8 space-y-1">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium outline-none transition focus:ring-2 focus:ring-moss-500",
                  active
                    ? "bg-moss-600 text-white"
                    : "text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-ink-800 dark:bg-ink-900/90">
          <div className="flex items-center justify-between gap-3">
            <nav className="flex gap-1 overflow-x-auto lg:hidden">
              {nav.slice(0, 7).map((item) => (
                <Link key={item.href} href={item.href} className="btn-secondary whitespace-nowrap px-2 py-1.5 text-xs">
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {isDemoMode ? (
                <span className="rounded-md bg-amberline/15 px-2 py-1 text-xs font-medium text-amberline">Env needed</span>
              ) : null}
              <button className="btn-secondary px-2" onClick={toggleTheme} aria-label="Toggle dark mode">
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              <div className="hidden text-right sm:block">
                <p className="text-sm font-medium">{user.displayName ?? "FocusOS Scholar"}</p>
                <p className="text-xs text-ink-500 dark:text-ink-400">{user.email ?? "Guest session"}</p>
              </div>
              <button className="btn-secondary px-2" onClick={logOut} aria-label="Sign out">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
