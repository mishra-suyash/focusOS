import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { createTier, listTiersWithUserCounts } from "@/lib/admin-tier-crud";
import type { NewTier } from "@/types";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;
  return NextResponse.json({ tiers: await listTiersWithUserCounts() });
}

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as NewTier | null;
  if (!body?.name || !body.limits || !body.allowedModels) {
    return NextResponse.json({ error: "name, limits and allowedModels are required." }, { status: 400 });
  }

  const tierId = await createTier(auth, body);
  return NextResponse.json({ tierId });
}
