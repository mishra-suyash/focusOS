import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { runGoogleCalendarSync } from "@/lib/google-calendar-admin";

/** Manual trigger for the calling user only — plan §8's "Sync now", same on-demand-vs-cron pattern
 * as every other daily-loop surface in this app. Phase 1: push only, no pull yet. */
export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  try {
    const result = await runGoogleCalendarSync(auth.uid);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Sync failed." }, { status: 500 });
  }
}
