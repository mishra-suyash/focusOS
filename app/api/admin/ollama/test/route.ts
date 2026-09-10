import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { getOllamaConfig } from "@/lib/admin-ollama-settings";
import { validateOllamaBaseUrl } from "@/lib/ai/ollama-validate";
import { testOllamaConnection } from "@/lib/ai/providers/ollama";

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => ({}))) as { baseUrl?: string };
  const config = await getOllamaConfig();
  const candidate = body.baseUrl ?? config.baseUrl;
  if (!candidate) return NextResponse.json({ error: "No address to test — provide baseUrl or save one first." }, { status: 400 });

  try {
    const validated = validateOllamaBaseUrl(candidate);
    const result = await testOllamaConnection(validated);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Invalid address." }, { status: 400 });
  }
}
