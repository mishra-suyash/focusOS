import { NextResponse } from "next/server";
import { generateEveningRollup } from "@/lib/admin-dailyloop";
import { getAdminSettings } from "@/lib/admin-settings";
import { recordCronRun } from "@/lib/admin-cron-log";
import { getActiveUids } from "@/lib/admin-users";

/** ~22:00 IST, or triggered by "End day" (plan §10.1) — this route is the cron path; the on-demand path is /api/daily-loop/rollup. */
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
        const rollup = await generateEveningRollup(uid);
        return { uid, ok: true, degraded: rollup.degraded };
      } catch (error) {
        return { uid, ok: false, error: error instanceof Error ? error.message : "unknown error" };
      }
    })
  );

  await recordCronRun("evening-rollup", { ok: results.every((r) => r.ok), detail: { processed: results.length } });
  return NextResponse.json({ results });
}
