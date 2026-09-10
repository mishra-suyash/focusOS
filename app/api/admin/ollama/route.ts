import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { getOllamaConfig, updateOllamaConfig } from "@/lib/admin-ollama-settings";
import { writeAuditEntry } from "@/lib/admin-audit";
import { isOllamaAvailable } from "@/lib/ai/providers/ollama";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const [config, health] = await Promise.all([getOllamaConfig(), isOllamaAvailable()]);
  return NextResponse.json({ config, available: health.available });
}

export async function PUT(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const patch = await request.json().catch(() => null);
  if (!patch) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  try {
    const before = await getOllamaConfig();
    const config = await updateOllamaConfig(patch, auth.uid);
    await writeAuditEntry({
      actorUid: auth.uid,
      actorEmail: auth.email,
      action: patch.enabled !== undefined && Object.keys(patch).length === 1 ? "ollama.toggle" : "ollama.config.change",
      targetType: "ollama",
      targetId: "admin/settings.ollama",
      before,
      after: patch
    });
    return NextResponse.json({ config });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update Ollama config." }, { status: 400 });
  }
}
