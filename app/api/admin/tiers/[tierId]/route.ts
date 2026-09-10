import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { DefaultTierDeleteError, deleteTier, updateTier } from "@/lib/admin-tier-crud";
import type { Tier, TierLimits } from "@/types";

export async function PATCH(request: Request, { params }: { params: Promise<{ tierId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { tierId } = await params;
  const patch = (await request.json().catch(() => null)) as Partial<{
    name: string;
    description: string;
    limits: TierLimits;
    allowedModels: Tier["allowedModels"];
  }> | null;
  if (!patch) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  try {
    await updateTier(auth, tierId, patch);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update tier." }, { status: 400 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ tierId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { tierId } = await params;
  try {
    const result = await deleteTier(auth, tierId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DefaultTierDeleteError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete tier." }, { status: 400 });
  }
}
