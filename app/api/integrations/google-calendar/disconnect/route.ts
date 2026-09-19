import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { disconnect } from "@/lib/google-calendar-admin";

/** plan §9.1 — revokes the token with Google (best-effort) and clears local state. Deliberately
 * does not delete the "FocusOS" Google calendar itself — see the plan's §13 open question 5. */
export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  try {
    await disconnect(auth.uid);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to disconnect." }, { status: 500 });
  }
}
