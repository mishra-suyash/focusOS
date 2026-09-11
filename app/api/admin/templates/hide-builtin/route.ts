import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { setBuiltinHidden } from "@/lib/admin-templates";

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as { builtinId?: string; hidden?: boolean } | null;
  if (!body?.builtinId || typeof body.hidden !== "boolean") {
    return NextResponse.json({ error: "builtinId and hidden are required." }, { status: 400 });
  }

  try {
    await setBuiltinHidden(auth, body.builtinId, body.hidden);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update built-in visibility." }, { status: 400 });
  }
}
