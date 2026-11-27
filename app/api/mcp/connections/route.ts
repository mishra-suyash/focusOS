/**
 * plan/19 §4.1/§5.3 — Settings → Connected apps: the signed-in person's own MCP connections (personal
 * access tokens and OAuth approvals), their activity log, and creating or revoking a connection.
 * Firebase-ID-token authenticated like every other user API route; everything is scoped to that uid.
 */
import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { userCol } from "@/lib/admin-writes";
import { mcpAccess } from "@/lib/mcp/access";
import { mcpResourceUrl, publicOrigin } from "@/lib/oauth/origin";
import { createPersonalAccessToken, isExpired, listUserTokens, normalizeScopes, revokeFamily, tokensCollection, type TokenRecord } from "@/lib/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Connection {
  familyId: string;
  kind: "pat" | "oauth";
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** An OAuth approval stays connected while its newest refresh token is live. */
  expiresAt?: string;
}

function connectionsOf(tokens: { record: TokenRecord }[]): Connection[] {
  const families = new Map<string, TokenRecord[]>();
  for (const { record } of tokens) families.set(record.familyId, [...(families.get(record.familyId) ?? []), record]);
  const list: Connection[] = [];
  for (const [familyId, records] of families) {
    const first = records.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    const lastUsedAt = records.map((r) => r.lastUsedAt).filter(Boolean).sort().pop();
    if (first.kind === "pat") {
      list.push({ familyId, kind: "pat", name: first.label ?? "Personal access token", scopes: first.scopes, createdAt: first.createdAt, lastUsedAt, revokedAt: first.revokedAt });
      continue;
    }
    const liveRefresh = records.filter((r) => r.kind === "refresh" && !r.revokedAt && !r.rotatedAt && !isExpired(r));
    const newest = records.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    list.push({
      familyId,
      kind: "oauth",
      name: first.clientName,
      scopes: newest.scopes,
      createdAt: first.createdAt,
      lastUsedAt,
      ...(liveRefresh.length === 0 ? { revokedAt: records.map((r) => r.revokedAt).filter(Boolean).sort().pop() ?? newest.expiresAt } : { expiresAt: liveRefresh[0].expiresAt })
    });
  }
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function GET(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;
  const [access, tokens, activity] = await Promise.all([
    mcpAccess(auth.uid),
    listUserTokens(auth.uid),
    userCol(auth.uid, "mcpActivity").orderBy("at", "desc").limit(50).get()
  ]);
  return NextResponse.json({
    access: access.ok ? { ok: true } : { ok: false, reason: access.reason },
    mcpUrl: mcpResourceUrl(publicOrigin(request)),
    connections: connectionsOf(tokens),
    activity: activity.docs.map((doc) => ({ id: doc.id, ...doc.data(), result: undefined }))
  });
}

export async function POST(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;
  const access = await mcpAccess(auth.uid);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { label?: string; scopes?: string[] } | null;
  const label = body?.label?.trim().slice(0, 80) || "Claude Code";
  const scopes = normalizeScopes(body?.scopes ?? ["read"]);
  const { token } = await createPersonalAccessToken(auth.uid, label, scopes);
  return NextResponse.json({ token, scopes, label });
}

export async function DELETE(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;
  const familyId = new URL(request.url).searchParams.get("familyId") ?? "";
  // Only a family that belongs to the caller: one of its tokens must carry their uid.
  const owned = await tokensCollection().where("familyId", "==", familyId).where("uid", "==", auth.uid).limit(1).get();
  if (owned.empty) return NextResponse.json({ error: "No such connection." }, { status: 404 });
  const revoked = await revokeFamily(familyId);
  return NextResponse.json({ revoked });
}
