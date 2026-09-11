import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { setPackDefaultTemplate } from "@/lib/admin-templates";
import type { PackId } from "@/types";

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as {
    packId?: PackId;
    slot?: "workdayTemplateId" | "breakDayTemplateId";
    templateId?: string | null;
  } | null;
  if (!body?.packId || !body.slot) return NextResponse.json({ error: "packId and slot are required." }, { status: 400 });

  try {
    await setPackDefaultTemplate(auth, body.packId, body.slot, body.templateId ?? null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to set pack default." }, { status: 400 });
  }
}
