import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { generateEveningRollup } from "@/lib/admin-dailyloop";

/** On-demand generation — also what "End day" calls (components/day-session-bar.tsx). */
export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  try {
    const rollup = await generateEveningRollup(auth.uid);
    return NextResponse.json({ rollup });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate the evening rollup." }, { status: 500 });
  }
}
