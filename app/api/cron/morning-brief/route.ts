import { NextResponse } from "next/server";
import { generateMorningBrief } from "@/lib/admin-dailyloop";
import { getAdminSettings } from "@/lib/admin-settings";
import { recordCronRun } from "@/lib/admin-cron-log";
import { getActiveUids } from "@/lib/admin-users";

/** ~06:00 IST (plan §10.1) — deterministic, no AI call, so there's nothing here for aiGloballyEnabled to gate. */
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
        await generateMorningBrief(uid);
        return { uid, ok: true };
      } catch (error) {
        return { uid, ok: false, error: error instanceof Error ? error.message : "unknown error" };
      }
    })
  );

  await recordCronRun("morning-brief", { ok: results.every((r) => r.ok), detail: { processed: results.length } });
  return NextResponse.json({ results });
}
