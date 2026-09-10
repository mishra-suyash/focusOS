import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { bootstrapOwnerIfNeeded } from "@/lib/admin-roles";
import { claimInviteIfAny } from "@/lib/admin-invites";

/**
 * Called once from the client right after every sign-in (see components/auth-provider.tsx).
 * Authenticated by the caller's own ID token — it can only ever act on the uid
 * the token belongs to. Does two things, both idempotent no-ops the vast
 * majority of the time: (1) grants the owner claim if BOOTSTRAP_OWNER_EMAIL
 * matches and no owner exists yet, (2) claims a pending invite for this email
 * if one exists.
 */
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: "Missing Authorization header." }, { status: 401 });

  try {
    const decoded = await adminAuth().verifyIdToken(token);
    const email = decoded.email ?? "";
    const bootstrapped = await bootstrapOwnerIfNeeded(decoded.uid, email);
    await claimInviteIfAny(decoded.uid, email);
    return NextResponse.json({ bootstrapped });
  } catch {
    return NextResponse.json({ error: "Invalid or expired token." }, { status: 401 });
  }
}
