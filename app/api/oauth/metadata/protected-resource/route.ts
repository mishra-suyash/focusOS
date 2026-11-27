/**
 * plan/19 §4.2 — RFC 9728 protected-resource metadata, served at /.well-known/oauth-protected-resource
 * (and its /api/mcp-suffixed form) through next.config.mjs rewrites. `resource` must equal the MCP URL
 * exactly as typed into Claude.
 */
import { corsPreflight, jsonResponse, mcpResourceUrl, publicOrigin } from "@/lib/oauth/origin";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const origin = publicOrigin(request);
  return jsonResponse({
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: ["read", "write", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "FocusLab"
  });
}

export const OPTIONS = () => corsPreflight();
