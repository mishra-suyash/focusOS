import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { listOwnDayTemplates } from "@/lib/admin-templates";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;
  return NextResponse.json({ dayTemplates: await listOwnDayTemplates(auth) });
}
