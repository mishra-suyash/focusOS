import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { buildAdminOverview } from "@/lib/admin-overview";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;
  return NextResponse.json(await buildAdminOverview());
}
