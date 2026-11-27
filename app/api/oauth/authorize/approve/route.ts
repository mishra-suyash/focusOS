/**
 * plan/19 §4.2 — the consent screen's Allow / Deny. The person is identified by their Firebase ID token
 * (the same `verifyActiveUser` every user API route uses), the request is checked again from scratch,
 * and the account must be allowed to use MCP (lib/mcp/access.ts). Allow returns the client's redirect
 * with a single-use code; Deny returns it with `access_denied`.
 */
import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { mcpAccess } from "@/lib/mcp/access";
import { checkAuthorizeRequest, issueAuthorizationCode, redirectWith, type AuthorizeParams } from "@/lib/oauth/authorize";
import { publicOrigin } from "@/lib/oauth/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;
  const body = (await request.json().catch(() => null)) as { params?: AuthorizeParams; decision?: "allow" | "deny"; allowWrite?: boolean } | null;
  if (!body?.params) return NextResponse.json({ error: "Missing the authorization request." }, { status: 400 });
  const origin = publicOrigin(request);
  const check = await checkAuthorizeRequest(body.params, origin);
  if (!check.ok) {
    if (check.redirect) return NextResponse.json({ redirect: check.redirect });
    return NextResponse.json({ error: check.description }, { status: 400 });
  }
  if (body.decision !== "allow") {
    return NextResponse.json({ redirect: redirectWith(check.redirectUri, { error: "access_denied", error_description: "The request was declined.", state: check.state, iss: origin }) });
  }
  const access = await mcpAccess(auth.uid);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });
  const scopes = body.allowWrite && check.scopes.includes("write") ? check.scopes : check.scopes.filter((scope) => scope !== "write");
  const code = await issueAuthorizationCode({
    uid: auth.uid,
    client: check.client,
    redirectUri: check.redirectUri,
    codeChallenge: check.codeChallenge,
    resource: check.resource,
    scopes: scopes.length > 0 ? scopes : ["read"]
  });
  return NextResponse.json({ redirect: redirectWith(check.redirectUri, { code, state: check.state, iss: origin }) });
}
