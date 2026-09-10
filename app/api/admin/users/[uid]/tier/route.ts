import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { assignUserTier } from "@/lib/admin-tier-crud";

export async function PATCH(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { uid } = await params;
  const body = (await request.json().catch(() => null)) as { tierId?: string | null } | null;
  if (body === null || body.tierId === undefined) return NextResponse.json({ error: "tierId is required." }, { status: 400 });

  try {
    await assignUserTier(auth, uid, body.tierId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to assign tier." }, { status: 400 });
  }
}
