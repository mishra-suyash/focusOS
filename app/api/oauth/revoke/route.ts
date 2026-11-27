/**
 * plan/19 §4.2 — RFC 7009 revocation. Revoking any token of an approval revokes the whole approval
 * (its access and refresh tokens). Always 200, whether or not the token was known, as the RFC requires.
 */
import { corsPreflight, jsonResponse } from "@/lib/oauth/origin";
import { getToken, revokeFamily } from "@/lib/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  const params = type.includes("application/json") ? ((await request.json().catch(() => ({}))) as Record<string, string>) : Object.fromEntries(new URLSearchParams(await request.text()));
  if (params.token) {
    const found = await getToken(params.token);
    // A PAT is revoked from Settings, not by a client that happens to hold it.
    if (found && found.record.kind !== "pat") await revokeFamily(found.record.familyId);
  }
  return jsonResponse({});
}

export const OPTIONS = () => corsPreflight();
