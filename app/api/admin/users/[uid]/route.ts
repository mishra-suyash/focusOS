import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { patchUser, type PatchUserInput } from "@/lib/admin-users";
import { RoleChangeError } from "@/lib/admin-roles";

export async function PATCH(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { uid } = await params;
  const patch = (await request.json().catch(() => null)) as PatchUserInput | null;
  if (!patch) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  try {
    await patchUser(auth, uid, patch);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof RoleChangeError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update user." }, { status: 500 });
  }
}
