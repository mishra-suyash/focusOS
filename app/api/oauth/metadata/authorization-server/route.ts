/**
 * plan/19 §4.2 — RFC 8414 authorization-server metadata, served at
 * /.well-known/oauth-authorization-server through next.config.mjs rewrites. FocusLab is its own small
 * OAuth 2.1 server: public clients only (PKCE S256, no client secret), registered by DCR or identified
 * by a Client ID Metadata Document.
 */
import { corsPreflight, jsonResponse, publicOrigin } from "@/lib/oauth/origin";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const origin = publicOrigin(request);
  return jsonResponse({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    scopes_supported: ["read", "write", "offline_access"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  });
}

export const OPTIONS = () => corsPreflight();
