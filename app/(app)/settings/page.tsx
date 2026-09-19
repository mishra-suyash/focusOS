"use client";

import { orderBy } from "firebase/firestore";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SectionHeader } from "@/components/section-header";
import { useAuth } from "@/components/auth-provider";
import { FloatingWidgetCustomizeDialog } from "@/components/floating-widget-customize-dialog";
import { GoogleCalendarSettings } from "@/components/google-calendar-settings";
import { InfoHint } from "@/components/info-hint";
import { useTheme } from "@/components/theme-provider";
import { useUserCollection } from "@/hooks/use-user-collection";
import { useUserSettings } from "@/hooks/use-user-settings";
import { useWorkdaySession } from "@/components/workday-session-provider";
import { downloadFullExportJson, downloadPomodoroCsv } from "@/lib/export";
import { DEFAULT_TIMEZONE } from "@/lib/google-calendar";
import { DEFAULT_MAX_REVISIONS_PER_DAY, DEFAULT_MAX_REVISION_MINUTES_PER_DAY, DEFAULT_LADDER } from "@/lib/revision";
import { useUserTier } from "@/lib/tiers";
import type { DayTemplate } from "@/types";

export default function SettingsPage() {
  const { user, isDemoMode } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { hydrationMinutes, breakMinutes, setHydrationMinutes, setBreakMinutes } = useWorkdaySession();
  const { settings, update: updateSettings } = useUserSettings();
  const { items: templates } = useUserCollection<DayTemplate>("dayTemplates", useMemo(() => [orderBy("createdAt", "desc")], []));
  const { tier, limits: tierLimits, allowedModels } = useUserTier();
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);
  const [floatingWidgetCustomizeOpen, setFloatingWidgetCustomizeOpen] = useState(false);

  function updateRevisionCap(field: "maxRevisionsPerDay" | "maxRevisionMinutesPerDay", value: number) {
    const ceiling = field === "maxRevisionsPerDay" ? tierLimits.maxRevisionsPerDay : tierLimits.maxRevisionMinutesPerDay;
    updateSettings({ [field]: Math.max(1, Math.min(value, ceiling)) });
  }

  async function exportJson() {
    if (!user) return;
    setExporting("json");
    try {
      await downloadFullExportJson(user.uid);
    } finally {
      setExporting(null);
    }
  }

  async function exportCsv() {
    if (!user) return;
    setExporting("csv");
    try {
      await downloadPomodoroCsv(user.uid);
    } finally {
      setExporting(null);
    }
  }

  return (
    <>
      <SectionHeader title="Settings" eyebrow="Workspace" />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Profile</h2>
          <dl className="space-y-3 text-sm">
            <div><dt className="label">Name</dt><dd>{user?.displayName ?? "FocusOS Scholar"}</dd></div>
            <div><dt className="label">Email</dt><dd>{user?.email ?? "Guest"}</dd></div>
            <div><dt className="label">User ID</dt><dd className="break-all font-mono text-xs">{user?.uid}</dd></div>
          </dl>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Features</h2>
          <p className="mb-3 text-xs text-ink-500">Turn optional modules like Courses, Revise, Goals, or Analytics on or off.</p>
          <Link href="/settings/features" className="btn-secondary py-1.5 text-xs">Manage features</Link>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Routine</h2>
          <p className="mb-3 text-xs text-ink-500">Sleep, meals, gym, or a custom recurring block — whichever are on appear locked on every matching day.</p>
          <Link href="/settings/routine" className="btn-secondary py-1.5 text-xs">Manage routine</Link>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Preferences</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md bg-ink-50 p-3 dark:bg-ink-800">
              <div>
                <p className="text-sm font-medium">Dark mode</p>
                <p className="text-xs text-ink-500">Current theme: {theme}</p>
              </div>
              <button className="btn-secondary" onClick={toggleTheme}>Toggle</button>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Timezone</span>
              <TimezoneSelect value={settings.timezone ?? DEFAULT_TIMEZONE} onChange={(timezone) => updateSettings({ timezone })} />
            </label>
            <p className="text-xs text-ink-500">Used for anything with a real clock time, including Google Calendar sync.</p>
          </div>
        </section>
        <GoogleCalendarSettings />
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Reminders</h2>
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Hydration reminder every</span>
              <input
                className="input w-24"
                type="number"
                min={15}
                value={hydrationMinutes}
                onChange={(e) => setHydrationMinutes(Number(e.target.value))}
              />
              <span className="text-xs text-ink-500">min</span>
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Break reminder every</span>
              <input className="input w-24" type="number" min={15} value={breakMinutes} onChange={(e) => setBreakMinutes(Number(e.target.value))} />
              <span className="text-xs text-ink-500">min</span>
            </label>
            <p className="text-xs text-ink-500">Reminders only fire while your day is started and this tab is open. Allow browser notifications when prompted to get alerts outside the tab.</p>
          </div>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Floating widget</h2>
          <p className="mb-3 text-xs text-ink-500">
            The picture-in-picture button near the top of the app floats a small, resizable, always-on-top window with your focus timer. Choose what shows in it. Chromium browsers only (Chrome, Edge, Arc, Dia).
          </p>
          <button className="btn-secondary py-1.5 text-xs" onClick={() => setFloatingWidgetCustomizeOpen(true)}>
            Customize
          </button>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 flex items-center gap-1 text-lg font-semibold">
            Break-day template
            <InfoHint term="breakDayTemplate" />
          </h2>
          <p className="mb-3 text-xs text-ink-500">
            Applied by &ldquo;Start day&rdquo; instead of your workday template on days with no active semester term (or an explicit break term).
          </p>
          <select
            className="input"
            value={settings.breakTemplateId ?? ""}
            onChange={(e) => updateSettings({ breakTemplateId: e.target.value || undefined })}
          >
            <option value="">Use the workday template</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Plan</h2>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-ink-500">Tier</span>
              <span className="font-medium">{tier?.name ?? "Default (no tiers configured)"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-500">AI models available</span>
              <span className="font-medium">{allowedModels.length > 0 ? allowedModels.join(", ") : "none"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-500">AI monthly budget</span>
              <span className="font-medium">${tierLimits.aiMonthlyBudgetUsd}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-500">Attached-PDF storage</span>
              <span className="font-medium">{tierLimits.blobQuotaMb} MB</span>
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-500">Plan limits are set by an admin. There&apos;s no self-service upgrade screen yet.</p>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Revision</h2>
          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Max items per day</span>
              <input
                className="input w-24"
                type="number"
                min={1}
                max={tierLimits.maxRevisionsPerDay}
                value={settings.maxRevisionsPerDay ?? DEFAULT_MAX_REVISIONS_PER_DAY}
                onChange={(e) => updateRevisionCap("maxRevisionsPerDay", Number(e.target.value))}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Max minutes per day</span>
              <input
                className="input w-24"
                type="number"
                min={5}
                max={tierLimits.maxRevisionMinutesPerDay}
                value={settings.maxRevisionMinutesPerDay ?? DEFAULT_MAX_REVISION_MINUTES_PER_DAY}
                onChange={(e) => updateRevisionCap("maxRevisionMinutesPerDay", Number(e.target.value))}
              />
            </label>
            <p className="text-xs text-ink-500">
              Revision schedule: {DEFAULT_LADDER.join(", ")} days. Overflow past today&apos;s cap rolls forward, it never disappears. Your plan&apos;s ceiling is{" "}
              {tierLimits.maxRevisionsPerDay} items / {tierLimits.maxRevisionMinutesPerDay} min.
            </p>
          </div>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-lg font-semibold">Export data</h2>
          <div className="space-y-3">
            <p className="text-sm text-ink-600 dark:text-ink-300">Download your data to analyze with an external AI tool or back it up.</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={exportJson} disabled={exporting !== null}>
                {exporting === "json" ? "Exporting..." : "Download full export (JSON)"}
              </button>
              <button className="btn-secondary" onClick={exportCsv} disabled={exporting !== null}>
                {exporting === "csv" ? "Exporting..." : "Download focus session log (CSV)"}
              </button>
            </div>
          </div>
        </section>
        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold">Firebase status</h2>
          <p className="text-sm text-ink-600 dark:text-ink-300">
            {isDemoMode
              ? "Firebase environment variables are missing. Configure .env.local or Vercel environment variables before production use."
              : "Firebase Auth and Firestore are configured from environment variables."}
          </p>
        </section>
      </div>
      {floatingWidgetCustomizeOpen ? (
        <FloatingWidgetCustomizeDialog
          settings={settings}
          onChange={(itemIds) => updateSettings({ floatingWidgetItems: itemIds })}
          onClose={() => setFloatingWidgetCustomizeOpen(false)}
        />
      ) : null}
    </>
  );
}

/** `Intl.supportedValuesOf` is widely supported in evergreen browsers but not guaranteed — falls
 * back to a plain text input (still just an IANA string, same validity requirement) if it's
 * missing, rather than blocking the whole timezone field on one API's availability. */
function TimezoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : null;
  if (!zones) {
    return <input className="input w-48" value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. Asia/Kolkata" />;
  }
  return (
    <select className="input w-48" value={value} onChange={(e) => onChange(e.target.value)}>
      {zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      ))}
    </select>
  );
}
