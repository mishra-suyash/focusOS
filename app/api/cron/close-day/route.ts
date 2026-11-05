import { NextResponse } from "next/server";
import { closeFinishedDay } from "@/lib/admin-dailyloop";
import { getAdminSettings } from "@/lib/admin-settings";
import { recordCronRun } from "@/lib/admin-cron-log";
import { getActiveUids } from "@/lib/admin-users";

/** ~05:10 IST, after the latest `dayEndsAt` (05:00): finalises the stored record of the day that just ended. */
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
        return { uid, ok: true, day: await closeFinishedDay(uid) };
      } catch (error) {
        return { uid, ok: false, error: error instanceof Error ? error.message : "unknown error" };
      }
    })
  );

  await recordCronRun("close-day", { ok: results.every((r) => r.ok), detail: { processed: results.length } });
  return NextResponse.json({ results });
}
