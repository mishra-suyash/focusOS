/**
 * plan/19 §3.3 — thin prompts that tell Claude which tools to call, and the instructions as a browsable
 * resource. Resource subscriptions and sampling aren't used: Claude's hosted apps don't support them.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { MCP_INSTRUCTIONS } from "@/lib/mcp/instructions";

function userPrompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer) {
  server.registerResource("guide", "focuslab://guide", { title: "How FocusLab works", description: "Vocabulary, day frames, derived values and planner rules.", mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: MCP_INSTRUCTIONS }]
  }));

  server.registerPrompt("review_today", { title: "Review today", description: "How today is going and what to do next." }, () =>
    userPrompt(
      "Using FocusLab: call get_overview, then get_day for today. Tell me how today is going against its plan (blocks closed, Workload band, Up next), what's slipping, and the one thing I should do next. Don't change anything unless I ask."
    )
  );

  server.registerPrompt("plan_my_week", { title: "Plan my week", description: "Look at the week and suggest sittings to add." }, () =>
    userPrompt(
      "Using FocusLab: call get_overview and get_week, and list_tasks for open work due in the next two weeks. Show me what this week already holds, what's owed (assessments, course targets, goals, reading), and propose specific sittings (date, time, length within my sitting bounds) in the gaps. Ask before adding any of them with add_block. The full planner stays in the app at /plan/week."
    )
  );

  server.registerPrompt("what_to_read_next", { title: "What should I read next?", description: "Pick the next paper and pass." }, () =>
    userPrompt(
      "Using FocusLab: call list_papers for queued, reading and inbox papers, and get_paper on the top few. Recommend what to read next and which pass (Skim, Read or Deep dive), and why, given my goals and courses from get_overview. Don't change anything unless I ask."
    )
  );
}
