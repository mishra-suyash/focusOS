/**
 * plan/19 §4.2 — checking an authorization request, once when the consent screen loads and again when
 * the person approves it. An unknown client or an unregistered redirect URI is shown on the page and
 * never redirected to (RFC 6749 §4.1.2.1): sending an error to an unverified URI would make FocusLab an
 * open redirector. Every other problem goes back to the client as an OAuth error.
 */
import { createHash, randomBytes } from "node:crypto";
import { redirectUriMatches, resolveClient, type OAuthClient } from "@/lib/oauth/clients";
import { mcpResourceUrl } from "@/lib/oauth/origin";
import { AUTH_CODE_TTL_SECONDS, codesCollection, hashSecret, normalizeScopes, type McpScope } from "@/lib/oauth/tokens";

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  resource?: string;
}

export type AuthorizeCheck =
  | { ok: true; client: OAuthClient; redirectUri: string; scopes: McpScope[]; resource: string; state?: string; codeChallenge: string }
  /** `redirect` is set only when the redirect URI is verified, so the error may be sent there. */
  | { ok: false; error: string; description: string; redirect?: string };

export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

export async function checkAuthorizeRequest(params: AuthorizeParams, origin: string): Promise<AuthorizeCheck> {
  const client = params.client_id ? await resolveClient(params.client_id) : null;
  if (!client) return { ok: false, error: "invalid_client", description: "This app isn't registered with FocusLab, or its registration couldn't be verified." };
  const redirectUri = params.redirect_uri ?? "";
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return { ok: false, error: "invalid_request", description: "The address this app asked to return to isn't one it registered." };
  }
  const back = (error: string, description: string): AuthorizeCheck => ({
    ok: false,
    error,
    description,
    redirect: redirectWith(redirectUri, { error, error_description: description, state: params.state, iss: origin })
  });
  if (params.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (params.code_challenge_method !== "S256" || !params.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  const resource = mcpResourceUrl(origin);
  if (params.resource && params.resource.replace(/\/+$/, "") !== resource) return back("invalid_target", `This server only issues tokens for ${resource}.`);
  return { ok: true, client, redirectUri, scopes: normalizeScopes(params.scope, ["read", "write"]), resource, state: params.state, codeChallenge: params.code_challenge };
}

/** A single-use code, valid for 60 seconds, stored only as its hash with everything the exchange must match. */
export async function issueAuthorizationCode(grant: {
  uid: string;
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: McpScope[];
}): Promise<string> {
  const code = `fl_code_${randomBytes(32).toString("base64url")}`;
  const now = Date.now();
  await codesCollection()
    .doc(hashSecret(code))
    .set({
      uid: grant.uid,
      clientId: grant.client.clientId,
      clientName: grant.client.clientName,
      redirectUri: grant.redirectUri,
      codeChallenge: grant.codeChallenge,
      resource: grant.resource,
      scopes: grant.scopes,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + AUTH_CODE_TTL_SECONDS * 1000).toISOString()
    });
  return code;
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}
