import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { getAdminSettings, updateAdminSettings } from "@/lib/admin-settings";
import { writeAuditEntry } from "@/lib/admin-audit";
import type { UserRole } from "@/types";

export class RoleChangeError extends Error {}

/**
 * Sets the `role` custom claim, revokes refresh tokens so it takes effect on the
 * caller's very next request rather than waiting up to an hour for token refresh,
 * and mirrors the value onto users/{uid}.role for listing/filtering (display data
 * only — every server route authorises from the claim, never this mirror).
 */
export async function setUserRole(
  actor: { uid: string; email: string; role: UserRole },
  targetUid: string,
  role: UserRole
): Promise<void> {
  const targetUser = await adminAuth().getUser(targetUid);
  const currentRole = (targetUser.customClaims?.role as UserRole | undefined) ?? "member";

  if (currentRole === "owner") {
    throw new RoleChangeError("The owner role cannot be changed by anyone, including the owner.");
  }
  if (role === "owner") {
    throw new RoleChangeError("There can only be one owner, set once at bootstrap.");
  }
  if (role === "admin" && actor.role !== "owner") {
    throw new RoleChangeError("Only the owner can grant the admin role.");
  }

  await adminAuth().setCustomUserClaims(targetUid, { role });
  await adminAuth().revokeRefreshTokens(targetUid);
  await adminDb().collection("users").doc(targetUid).set({ role, updatedAt: new Date().toISOString() }, { merge: true });

  await writeAuditEntry({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action: "user.role.change",
    targetType: "user",
    targetId: targetUid,
    before: { role: currentRole },
    after: { role }
  });
}

export async function forceSignOut(actor: { uid: string; email: string }, targetUid: string): Promise<void> {
  await adminAuth().revokeRefreshTokens(targetUid);
  await writeAuditEntry({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action: "user.disable",
    targetType: "user",
    targetId: targetUid,
    after: { forcedSignOut: true }
  });
}

/**
 * Called once per sign-in (from a client-triggered route, since there's no Auth
 * trigger infra here). If BOOTSTRAP_OWNER_EMAIL is set, no owner has ever been
 * bootstrapped, and the signed-in email matches, grants the owner claim once and
 * marks admin/settings.ownerBootstrapped so this never fires again. Inert
 * otherwise — no hardcoded password, no chicken-and-egg to get the first admin.
 */
export async function bootstrapOwnerIfNeeded(uid: string, email: string): Promise<boolean> {
  const bootstrapEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
  if (!bootstrapEmail || email.toLowerCase() !== bootstrapEmail.toLowerCase()) return false;

  const settings = await getAdminSettings();
  if (settings.ownerBootstrapped) return false;

  await adminAuth().setCustomUserClaims(uid, { role: "owner" });
  await adminAuth().revokeRefreshTokens(uid);
  await adminDb().collection("users").doc(uid).set({ role: "owner", updatedAt: new Date().toISOString() }, { merge: true });
  await updateAdminSettings({ ownerBootstrapped: true }, { uid, email });
  await writeAuditEntry({ actorUid: uid, actorEmail: email, action: "owner.bootstrap", targetType: "user", targetId: uid });
  return true;
}
