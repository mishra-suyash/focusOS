import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import type { UserRole } from "@/types";

export interface VerifiedCaller {
  uid: string;
  email: string;
  role: UserRole;
}

async function verifyToken(request: Request): Promise<VerifiedCaller | { error: NextResponse }> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return { error: NextResponse.json({ error: "Missing Authorization header." }, { status: 401 }) };

  try {
    const decoded = await adminAuth().verifyIdToken(token);
    // Accounts created before Phase 4.5's role claims default to "member" — an
    // unset claim is not the same as `disabled` and must not lock anyone out.
    const role = (decoded.role as UserRole | undefined) ?? "member";
    return { uid: decoded.uid, email: decoded.email ?? "", role };
  } catch {
    return { error: NextResponse.json({ error: "Invalid or expired token." }, { status: 401 }) };
  }
}

/**
 * Any signed-in, non-disabled account. Gates /api/ai/**, /api/insights and
 * /api/files/upload-token — superseded the OWNER_UIDS allowlist now that the
 * app has real multi-user roles (a disabled user is rejected here in addition
 * to at the Firestore rules layer; every other role passes through unchanged,
 * with per-user AI budget/blob quota enforced later, deeper in each route).
 */
export async function verifyActiveUser(request: Request): Promise<VerifiedCaller | { error: NextResponse }> {
  const result = await verifyToken(request);
  if ("error" in result) return result;
  if (result.role === "disabled") {
    return { error: NextResponse.json({ error: "This account has been disabled." }, { status: 403 }) };
  }
  return result;
}

/**
 * Owner or admin only. Gates every /api/admin/** route. Returns 404 rather
 * than 403 on the client screens (see app/(admin)/admin/layout.tsx) so the
 * panel's existence isn't advertised — but routes themselves return a normal
 * error body since this is the last line of authorization defense, not UX.
 */
export async function verifyAdminRequest(request: Request): Promise<VerifiedCaller | { error: NextResponse }> {
  const result = await verifyToken(request);
  if ("error" in result) return result;
  if (result.role !== "owner" && result.role !== "admin") {
    return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }
  return result;
}

export function isOwnerRole(role: UserRole): boolean {
  return role === "owner";
}
