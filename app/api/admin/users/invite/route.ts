import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { createInvite } from "@/lib/admin-invites";

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as { email?: string; tierId?: string } | null;
  if (!body?.email) return NextResponse.json({ error: "email is required." }, { status: 400 });

  await createInvite(auth, body.email, body.tierId);
  return NextResponse.json({ ok: true });
}
