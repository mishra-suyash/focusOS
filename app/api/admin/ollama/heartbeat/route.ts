import { NextResponse } from "next/server";
import { reportOllamaHeartbeat } from "@/lib/admin-ollama-settings";
import { writeAuditEntry } from "@/lib/admin-audit";

/**
 * Not gated by a user token — authenticated by a shared secret only, per plan
 * §9.2.2 and admin-panel §5. Called by a cron script on the Ollama box itself
 * reporting its current public address. Accepts nothing except `baseUrl`.
 */
let lastAcceptedAt = 0;
const MIN_INTERVAL_MS = 60_000;

export async function POST(request: Request) {
  const secret = process.env.OLLAMA_HEARTBEAT_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  if (Date.now() - lastAcceptedAt < MIN_INTERVAL_MS) {
    return NextResponse.json({ error: "Rate limited — one heartbeat per minute." }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl : null;
  if (!baseUrl) return NextResponse.json({ error: "baseUrl is required." }, { status: 400 });

  try {
    const result = await reportOllamaHeartbeat(baseUrl);
    lastAcceptedAt = Date.now();
    if (result.changed) {
      await writeAuditEntry({
        actorUid: "heartbeat",
        actorEmail: "heartbeat",
        action: "ollama.address.heartbeat",
        targetType: "ollama",
        targetId: "admin/settings.ollama",
        after: { baseUrl }
      });
    }
    return NextResponse.json({ changed: result.changed });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid baseUrl." }, { status: 400 });
  }
}
