import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { buildConsentUrl } from "@/lib/google-calendar-admin";

/**
 * plan/11.FocusOS-v2-Google-Calendar-Sync-Plan.md §9.1 — returns the Google consent URL rather than
 * redirecting itself, since a full-page navigation (what a real OAuth redirect needs) can't carry a
 * Firebase Authorization header. Settings' "Connect Google Calendar" button fetches this with the
 * user's ID token, then does `window.location.href = url` itself.
 */
export async function GET(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  try {
    return NextResponse.json({ url: buildConsentUrl(auth.uid) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Google Calendar is not configured." }, { status: 500 });
  }
}
