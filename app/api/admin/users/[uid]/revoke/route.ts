import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { forceSignOut } from "@/lib/admin-roles";

export async function POST(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { uid } = await params;
  await forceSignOut(auth, uid);
  return NextResponse.json({ ok: true });
}
