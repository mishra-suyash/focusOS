import { NextResponse } from "next/server";
import { closeFinishedDays } from "@/lib/admin-dailyloop";
import { getAdminSettings } from "@/lib/admin-settings";
import { recordCronRun } from "@/lib/admin-cron-log";
import { getActiveUids } from "@/lib/admin-users";

/**
 * ~06:30 IST: finalises the stored record of the days that have ended. Hobby crons fire anywhere within
 * their hour, so this sits an hour clear of the latest `dayEndsAt` (05:00) in IST. In a zone where it
 * lands before that, `closeFinishedDays` picks the open day up on the next run.
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
        return { uid, ok: true, days: await closeFinishedDays(uid) };
      } catch (error) {
        return { uid, ok: false, error: error instanceof Error ? error.message : "unknown error" };
      }
    })
  );

  await recordCronRun("close-day", { ok: results.every((r) => r.ok), detail: { processed: results.length } });
  return NextResponse.json({ results });
}
