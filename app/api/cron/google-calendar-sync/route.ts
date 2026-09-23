import { NextResponse } from "next/server";
import { getConnection, runGoogleCalendarSync } from "@/lib/google-calendar-admin";
import { getAdminSettings } from "@/lib/admin-settings";
import { recordCronRun } from "@/lib/admin-cron-log";
import { getActiveUids } from "@/lib/admin-users";

/**
 * plan/11.FocusOS-v2-Google-Calendar-Sync-Plan.md §13 — the daily reconciliation half of "auto
 * sync" (the other half is the fire-and-forget push `useDayAutosave` fires right after a plan-day
 * edit settles, for near-real-time reflection between cron runs). Same fan-out shape as every other
 * cron in this repo (recurring-tasks, morning-brief, evening-rollup): CRON_SECRET → cronEnabled →
 * getActiveUids → per-uid try/catch → recordCronRun.
 *
 * Checks `getConnection(uid)?.connected` before calling into the push, rather than letting
 * `runGoogleCalendarSync` throw "Not connected to Google Calendar." for every uid that never
 * connected — with `getActiveUids()` covering every active user, that would mark this cron
 * permanently `ok: false` and burn a sync attempt on accounts that have nothing to sync.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const settings = await getAdminSettings();
  if (!settings.cronEnabled) {
    return NextResponse.json({ skipped: "cronEnabled is off in admin/settings" });
  }
  const uids = await getActiveUids();
  const results = await Promise.all(
    uids.map(async (uid) => {
      try {
        const connection = await getConnection(uid);
        if (!connection?.connected) return { uid, ok: true, skipped: true };
        const outcome = await runGoogleCalendarSync(uid);
        return { uid, ok: true, ...outcome };
      } catch (error) {
        return { uid, ok: false, error: error instanceof Error ? error.message : "unknown error" };
      }
    })
  );
  await recordCronRun("google-calendar-sync", { ok: results.every((r) => r.ok), detail: { processed: results.length } });
  return NextResponse.json({ results });
}
