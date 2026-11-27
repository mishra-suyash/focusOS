/**
 * plan/19 §4.2 — what the consent screen shows before anyone approves: which app is asking, where it
 * will send the person back to, and which scopes it wants. An invalid request is explained on the page.
 */
import { NextResponse } from "next/server";
import { checkAuthorizeRequest, type AuthorizeParams } from "@/lib/oauth/authorize";
import { publicOrigin } from "@/lib/oauth/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams) as AuthorizeParams;
  const check = await checkAuthorizeRequest(params, publicOrigin(request));
  if (!check.ok) return NextResponse.json({ ok: false, error: check.error, description: check.description, redirect: check.redirect }, { status: 400 });
  return NextResponse.json({ ok: true, clientName: check.client.clientName, redirectHost: new URL(check.redirectUri).host, scopes: check.scopes });
}
