"use client";

import { ArrowLeft, Cpu, Gauge, LayoutDashboard, ScrollText, Settings, SquareStack, Users } from "lucide-react";
import Link from "next/link";
import { notFound, usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { clsx } from "clsx";

const nav = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/tiers", label: "Tiers", icon: Gauge },
  { href: "/admin/templates", label: "Templates", icon: SquareStack },
  { href: "/admin/usage", label: "Usage", icon: ScrollText },
  { href: "/admin/ollama", label: "Ollama", icon: Cpu },
  { href: "/admin/settings", label: "Settings", icon: Settings },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText }
];

/**
 * Gated on the `role` custom claim, mirrored from the ID token by
 * components/auth-provider.tsx. This client-side check is UX only — every
 * /api/admin/** route independently re-verifies the role server-side, which
 * is the actual authorization boundary (admin panel §4, "don't advertise the
 * panel's existence": a non-admin hitting any /admin route gets Next's
 * default 404, not a 403 that would confirm the panel exists).
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, role, loading } = useAuth();
  const pathname = usePathname();

  if (loading || role === null) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-ink-500">Loading...</div>;
  }
  if (!user) return null;
  if (role !== "owner" && role !== "admin") return notFound();

  return (
    <div className="min-h-screen bg-ink-50 text-ink-950 dark:bg-ink-950 dark:text-ink-50">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-ink-200 bg-white p-4 dark:border-ink-800 dark:bg-ink-900 lg:block">
        <Link href="/dashboard" className="mb-6 flex items-center gap-2 px-2 py-2 text-sm text-ink-500 hover:text-ink-950 dark:text-ink-400 dark:hover:text-ink-50">
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Link>
        <p className="mb-4 px-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Admin panel</p>
        <nav className="space-y-1">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
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
          })}
        </nav>
      </aside>
      <div className="lg:pl-60">
        <nav className="flex gap-1 overflow-x-auto border-b border-ink-200 bg-white px-4 py-2 dark:border-ink-800 dark:bg-ink-900 lg:hidden">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="btn-secondary whitespace-nowrap px-2 py-1.5 text-xs">
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
