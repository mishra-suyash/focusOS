import { NextResponse } from "next/server";
import { completeOAuthConnect, verifyOAuthState } from "@/lib/google-calendar-admin";

/**
 * Google redirects the browser here directly — there is no Firebase Authorization header on this
 * request at all (Google doesn't know about Firebase auth), so the FocusOS uid comes from the
 * signed `state` param instead (plan §10's CSRF callout; `verifyOAuthState` checks the signature
 * and a 10-minute expiry). Always redirects back to /settings, success or failure, since this route
 * has no UI of its own — the query params it appends are read there.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const settingsUrl = new URL("/settings", url.origin);

  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    settingsUrl.searchParams.set("googleCalendarError", errorParam);
    return NextResponse.redirect(settingsUrl);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    settingsUrl.searchParams.set("googleCalendarError", "missing_code_or_state");
    return NextResponse.redirect(settingsUrl);
  }

  try {
    const uid = verifyOAuthState(state);
    await completeOAuthConnect(code, uid);
    settingsUrl.searchParams.set("googleCalendarConnected", "1");
  } catch (error) {
    settingsUrl.searchParams.set("googleCalendarError", error instanceof Error ? error.message : "connect_failed");
  }

  return NextResponse.redirect(settingsUrl);
}
