/**
 * plan/19 §7 — the MCP server: a fresh `McpServer` per request, its tools closed over that request's
 * `ToolContext`. Nothing is shared between requests, so one caller's uid can never reach another
 * caller's tools — the isolation is structural, not a convention each tool has to remember.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/instructions";
import type { ToolContext } from "@/lib/mcp/context";
import { registerReadTools } from "@/lib/mcp/tools/read";
import { registerRoutineTools } from "@/lib/mcp/tools/routine";
import { registerScheduleTools } from "@/lib/mcp/tools/schedule";
import { registerWriteTools } from "@/lib/mcp/tools/write";
import { registerPrompts } from "@/lib/mcp/prompts";

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "focuslab", title: "FocusLab", version: "1.0.0" }, { instructions: MCP_INSTRUCTIONS });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerScheduleTools(server, ctx);
  registerRoutineTools(server, ctx);
  registerPrompts(server);
  return server;
}
