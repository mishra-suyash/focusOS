import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { generateMorningBrief } from "@/lib/admin-dailyloop";

/** On-demand generation — the acceptance path for "deleting the cron's output and reopening the dashboard offers on-demand generation" (plan §12). */
export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  try {
    const brief = await generateMorningBrief(auth.uid);
    return NextResponse.json({ brief });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate the morning brief." }, { status: 500 });
  }
}
