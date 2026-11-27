/**
 * plan/19 — the FocusLab MCP endpoint. Streamable HTTP, stateless: every request is authenticated on
 * its own (lib/mcp/auth.ts) and served by a fresh server built for that caller (lib/mcp/server.ts).
 */
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { recordUsage } from "@/lib/admin-writes";
import { authenticateMcpRequest } from "@/lib/mcp/auth";
import { createToolContext, type ToolContext } from "@/lib/mcp/context";
import { buildMcpServer } from "@/lib/mcp/server";
import { corsPreflight, withCors } from "@/lib/oauth/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(
  ({ authInfo }) => {
    const ctx = (authInfo?.extra as { ctx?: ToolContext } | undefined)?.ctx;
    // Unreachable: every request reaching the handler was authenticated first and carries its context.
    if (!ctx) throw new Error("Unauthenticated MCP request reached the server factory.");
    return buildMcpServer(ctx);
  },
  { responseMode: "json", onerror: (error) => console.error("[mcp]", error.message) }
);

async function handle(request: Request): Promise<Response> {
  const auth = await authenticateMcpRequest(request);
  if ("response" in auth) return auth.response;
  const ctx = createToolContext(auth.caller);
  const authInfo: AuthInfo = { ...auth.authInfo, extra: { ...auth.authInfo.extra, ctx } };
  try {
    const response = await handler.fetch(request, { authInfo });
    return withCors(new Response(response.body, { status: response.status, statusText: response.statusText, headers: new Headers(response.headers) }));
  } finally {
    // plan/19 §5.3 — MCP traffic counted in the same monthly usage doc the app's meter writes.
    void recordUsage(ctx.uid, ctx.meter.reads, ctx.meter.writes).catch(() => undefined);
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = () => corsPreflight();
