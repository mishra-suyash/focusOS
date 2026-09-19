import { NextResponse } from "next/server";
import { generateRecurringTaskInstances } from "@/lib/admin-recurring-tasks";
import { getAdminSettings } from "@/lib/admin-settings";
import { recordCronRun } from "@/lib/admin-cron-log";
import { getActiveUids } from "@/lib/admin-users";
import { addDaysToKey, todayKey } from "@/lib/dates";

/** Daily — plan `10.FocusOS-v2-Connected-Flow-Plan.md` §4.2. Rolling 14-day window (today through
 * today+13) per active user, so a recurring commitment shows up in Tasks' "This week"/"Upcoming"
 * ahead of the morning it's actually due, not just on the day itself. */
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

  const today = todayKey();
  const toDateKey = addDaysToKey(today, 13);
  const uids = await getActiveUids();
  const results = await Promise.all(
    uids.map(async (uid) => {
      try {
        const { created } = await generateRecurringTaskInstances(uid, today, toDateKey);
        return { uid, ok: true, created };
      } catch (error) {
        return { uid, ok: false, error: error instanceof Error ? error.message : "unknown error" };
      }
    })
  );

  await recordCronRun("recurring-tasks", { ok: results.every((r) => r.ok), detail: { processed: results.length } });
  return NextResponse.json({ results });
}
