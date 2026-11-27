/**
 * plan/19 §4.2 — the one public origin the MCP resource and the OAuth issuer are named by. Claude
 * requires the protected-resource `resource` to equal the URL exactly as it was typed into Claude, so
 * this is never derived from `request.url` in production, where a request can arrive on the
 * deployment's own `*.vercel.app` URL.
 *
 * Order: `MCP_PUBLIC_ORIGIN` if set (the production domain, or a tunnel's URL while testing); else
 * Vercel's production domain on a production deployment; else the host the request came to (local dev,
 * previews).
 */
export function publicOrigin(request: Request): string {
  const configured = process.env.MCP_PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** The MCP endpoint's URL — the RFC 8707 resource every OAuth token is bound to. */
export function mcpResourceUrl(origin: string): string {
  return `${origin}/api/mcp`;
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

/** CORS for the endpoints Claude's clients call cross-origin. Bearer tokens, never cookies, so `*` is safe. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, mcp-session-id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400"
};

export function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  return response;
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** A JSON response with CORS and `no-store` (RFC 6749 §5.1 requires it on token responses). */
export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...CORS_HEADERS, ...extraHeaders }
  });
}
