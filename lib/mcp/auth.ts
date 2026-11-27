/**
 * plan/19 §4.3 — on every MCP request: find the token, check it's live and meant for this server, check
 * the account may use MCP, and hand the tool layer exactly one thing to scope every query by: the uid the
 * token belongs to. No tool takes a uid argument, and the Admin SDK bypasses Firestore rules, so this is
 * the only thing keeping one user's data from another's.
 */
import type { AuthInfo } from "@modelcontextprotocol/server";
import { mcpAccess } from "@/lib/mcp/access";
import { jsonResponse, mcpResourceUrl, protectedResourceMetadataUrl, publicOrigin } from "@/lib/oauth/origin";
import { getToken, isExpired, tokensCollection, type McpScope, type TokenKind } from "@/lib/oauth/tokens";

/** What a tool handler knows about its caller, carried in `AuthInfo.extra`. */
export interface McpCaller {
  uid: string;
  scopes: McpScope[];
  clientId: string;
  clientName: string;
  tokenKind: TokenKind;
  tokenId: string;
}

const LAST_USED_DEBOUNCE_MS = 10 * 60 * 1000;

/** A 401 that tells Claude where to start OAuth (Claude requires the 401; it ignores the header on a 200). */
export function unauthorized(request: Request, error?: { code: "invalid_token"; description: string }): Response {
  const origin = publicOrigin(request);
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(origin)}"`, `scope="read write"`];
  if (error) parts.unshift(`error="${error.code}"`, `error_description="${error.description}"`);
  return jsonResponse(
    { error: error?.code ?? "unauthorized", error_description: error?.description ?? "Sign in to FocusLab to connect." },
    401,
    { "WWW-Authenticate": `Bearer ${parts.join(", ")}` }
  );
}

export async function authenticateMcpRequest(request: Request): Promise<{ authInfo: AuthInfo; caller: McpCaller } | { response: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const secret = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!secret) return { response: unauthorized(request) };

  const found = await getToken(secret);
  if (!found) return { response: unauthorized(request, { code: "invalid_token", description: "Unknown token." }) };
  const { id, record } = found;
  if (record.kind === "refresh") return { response: unauthorized(request, { code: "invalid_token", description: "A refresh token can't call the API." }) };
  if (record.revokedAt) return { response: unauthorized(request, { code: "invalid_token", description: "This connection was revoked." }) };
  if (isExpired(record)) return { response: unauthorized(request, { code: "invalid_token", description: "The token has expired." }) };
  // MCP authorization spec: a server MUST only accept tokens issued for itself (RFC 8707 audience).
  if (record.kind === "access" && record.resource !== mcpResourceUrl(publicOrigin(request))) {
    return { response: unauthorized(request, { code: "invalid_token", description: "This token was issued for a different server." }) };
  }

  const access = await mcpAccess(record.uid);
  if (!access.ok) return { response: jsonResponse({ error: "access_denied", error_description: access.reason }, access.status) };

  if (!record.lastUsedAt || Date.now() - Date.parse(record.lastUsedAt) > LAST_USED_DEBOUNCE_MS) {
    void tokensCollection().doc(id).update({ lastUsedAt: new Date().toISOString() }).catch(() => undefined);
  }

  const caller: McpCaller = { uid: record.uid, scopes: record.scopes, clientId: record.clientId, clientName: record.clientName, tokenKind: record.kind, tokenId: id };
  const authInfo: AuthInfo = {
    token: secret,
    clientId: record.clientId,
    scopes: record.scopes,
    ...(record.expiresAt ? { expiresAt: Math.floor(Date.parse(record.expiresAt) / 1000) } : {}),
    resourceMetadataUrl: protectedResourceMetadataUrl(publicOrigin(request)),
    extra: { caller }
  };
  return { authInfo, caller };
}
