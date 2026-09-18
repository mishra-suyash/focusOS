import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { generateRecurringTaskInstances } from "@/lib/admin-recurring-tasks";
import { addDaysToKey, todayKey } from "@/lib/dates";

/** On-demand generation — the course card's "Generate now", mirroring app/api/daily-loop/brief's
 * same on-demand-vs-cron pattern. Same rolling 14-day window as the cron (§4.2), not just today,
 * so a newly created or edited commitment shows up in Tasks' "This week"/"Upcoming" right away. */
export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  try {
    const today = todayKey();
    const result = await generateRecurringTaskInstances(auth.uid, today, addDaysToKey(today, 13));
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate recurring tasks." }, { status: 500 });
  }
}
