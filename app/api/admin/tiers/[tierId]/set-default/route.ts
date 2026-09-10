import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { setDefaultTier } from "@/lib/admin-tier-crud";

export async function POST(request: Request, { params }: { params: Promise<{ tierId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { tierId } = await params;
  try {
    await setDefaultTier(auth, tierId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to set default tier." }, { status: 400 });
  }
}
