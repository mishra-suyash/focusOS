/**
 * plan/19 §4.2 — RFC 6749 token endpoint, public clients with PKCE.
 *
 * - `authorization_code`: the code is spent in the same transaction that issues the tokens, so it works
 *   once. It must be unexpired, for this client and redirect URI, match the PKCE verifier, and (when the
 *   client names one) the same resource.
 * - `refresh_token`: rotates on every use. A refresh token presented a second time is reuse, which
 *   revokes its whole family — every token from that approval — in the same transaction.
 *
 * Errors are RFC 6749 codes; an expired, used or revoked grant is `invalid_grant`, which is what tells
 * Claude to start over with a fresh approval.
 */
import { randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase-admin";
import { mcpAccess } from "@/lib/mcp/access";
import { pkceMatches } from "@/lib/oauth/authorize";
import { corsPreflight, jsonResponse, mcpResourceUrl, publicOrigin } from "@/lib/oauth/origin";
import { codesCollection, hashSecret, isExpired, issueTokenPair, normalizeScopes, revokeFamily, tokensCollection, type IssuedTokens, type McpScope, type TokenRecord } from "@/lib/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function oauthError(error: string, description: string, status = 400) {
  return jsonResponse({ error, error_description: description }, status);
}

async function readParams(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

interface CodeRecord {
  uid: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: McpScope[];
  expiresAt: string;
}

type Outcome = { tokens: IssuedTokens } | { error: string; description: string };

export async function POST(request: Request) {
  const params = await readParams(request);
  const origin = publicOrigin(request);
  const resource = mcpResourceUrl(origin);
  if (params.resource && params.resource.replace(/\/+$/, "") !== resource) return oauthError("invalid_target", `This server only issues tokens for ${resource}.`);

  if (params.grant_type === "authorization_code") {
    if (!params.code || !params.code_verifier || !params.client_id || !params.redirect_uri) return oauthError("invalid_request", "code, code_verifier, client_id and redirect_uri are required.");
    const ref = codesCollection().doc(hashSecret(params.code));
    const outcome: Outcome | { uid: string } = await adminDb().runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return { error: "invalid_grant", description: "The code is unknown or was already used." };
      const code = snapshot.data() as CodeRecord;
      tx.delete(ref);
      if (isExpired(code)) return { error: "invalid_grant", description: "The code has expired." };
      if (code.clientId !== params.client_id) return { error: "invalid_grant", description: "The code was issued to a different client." };
      if (code.redirectUri !== params.redirect_uri) return { error: "invalid_grant", description: "redirect_uri doesn't match the authorization request." };
      if (!pkceMatches(params.code_verifier, code.codeChallenge)) return { error: "invalid_grant", description: "The PKCE code_verifier doesn't match." };
      if (code.resource !== resource) return { error: "invalid_grant", description: "The code was issued for a different resource." };
      return { tokens: issueTokenPair({ uid: code.uid, clientId: code.clientId, clientName: code.clientName, scopes: code.scopes, resource, familyId: randomUUID() }, tx) };
    });
    if ("error" in outcome) return oauthError(outcome.error, outcome.description);
    return jsonResponse((outcome as { tokens: IssuedTokens }).tokens);
  }

  if (params.grant_type === "refresh_token") {
    if (!params.refresh_token) return oauthError("invalid_request", "refresh_token is required.");
    const ref = tokensCollection().doc(hashSecret(params.refresh_token));
    const outcome: Outcome & { uid?: string; familyId?: string } = await adminDb().runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return { error: "invalid_grant", description: "Unknown refresh token." };
      const record = snapshot.data() as TokenRecord;
      if (record.kind !== "refresh") return { error: "invalid_grant", description: "Not a refresh token." };
      if (record.rotatedAt || record.revokedAt) {
        // Reuse after rotation means the token leaked: end every token from this approval.
        if (record.rotatedAt && !record.revokedAt) await revokeFamily(record.familyId, tx);
        return { error: "invalid_grant", description: "This refresh token was already used or revoked; connect FocusLab again." };
      }
      if (isExpired(record)) return { error: "invalid_grant", description: "The refresh token has expired; connect FocusLab again." };
      if (params.client_id && params.client_id !== record.clientId) return { error: "invalid_grant", description: "The refresh token was issued to a different client." };
      if (record.resource !== resource) return { error: "invalid_grant", description: "The refresh token was issued for a different resource." };
      const requested = params.scope ? normalizeScopes(params.scope, record.scopes) : record.scopes;
      if (requested.some((scope) => !record.scopes.includes(scope))) return { error: "invalid_scope", description: "A refresh can't widen the approved scopes." };
      tx.update(ref, { rotatedAt: new Date().toISOString() });
      return { uid: record.uid, familyId: record.familyId, tokens: issueTokenPair({ uid: record.uid, clientId: record.clientId, clientName: record.clientName, scopes: requested, resource, familyId: record.familyId }, tx) };
    });
    if ("error" in outcome) return oauthError(outcome.error, outcome.description);
    // A disabled account, or MCP switched off, can't keep a connection alive by refreshing.
    const access = await mcpAccess(outcome.uid!);
    if (!access.ok) {
      await revokeFamily(outcome.familyId!);
      return oauthError("invalid_grant", access.reason);
    }
    return jsonResponse(outcome.tokens);
  }

  return oauthError("unsupported_grant_type", "Supported: authorization_code, refresh_token.");
}

export const OPTIONS = () => corsPreflight();
