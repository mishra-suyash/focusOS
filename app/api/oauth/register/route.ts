/**
 * plan/19 §4.2 — RFC 7591 Dynamic Client Registration, for public clients only. A client may register
 * Claude's hosted callback and loopback redirects (Claude Code), nothing else.
 */
import { isAllowedRedirectUri, registerClient } from "@/lib/oauth/clients";
import { corsPreflight, jsonResponse } from "@/lib/oauth/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalid(error: "invalid_redirect_uri" | "invalid_client_metadata", description: string) {
  return jsonResponse({ error, error_description: description }, 400);
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
    grant_types?: unknown;
    response_types?: unknown;
  } | null;
  if (!body || typeof body !== "object") return invalid("invalid_client_metadata", "Expected a JSON body.");
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  if (redirectUris.length === 0 || redirectUris.length > 5) return invalid("invalid_redirect_uri", "Give one to five redirect_uris.");
  const rejected = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
  if (rejected) return invalid("invalid_redirect_uri", `Redirect URI not allowed: ${rejected}. Only Claude's callback and loopback addresses are accepted.`);
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return invalid("invalid_client_metadata", "Only public clients (token_endpoint_auth_method \"none\") are supported.");
  }
  const clientName = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "Claude";
  const client = await registerClient({ clientName, redirectUris });
  return jsonResponse(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    },
    201
  );
}

export const OPTIONS = () => corsPreflight();
