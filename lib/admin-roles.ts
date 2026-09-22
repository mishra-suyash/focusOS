import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { getAdminSettings, updateAdminSettings } from "@/lib/admin-settings";
import { writeAuditEntry } from "@/lib/admin-audit";
import { inviteId } from "@/lib/admin-invites";
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

/**
 * plan/13 D1 — `admin/settings.signupMode` previously changed nothing: whatever sign-in methods
 * were enabled could always create a brand-new account. Called from the bootstrap route right
 * after a sign-in, so "Invite only"/"Closed" is now real: a genuinely first-time account
 * (`creationTime === lastSignInTime` — an existing user re-authenticating is never touched, since
 * this setting is about signups, not about kicking existing people out; see `forceSignOut` for
 * that) gets disabled again when it isn't covered by a pending invite ("invite" mode) or isn't
 * allowed at all ("closed" mode).
 *
 * Disables rather than deletes: `creationTime === lastSignInTime` is a heuristic, not a certainty,
 * and a wrong-but-successful match here would otherwise be an unrecoverable deletion. Disabling is
 * the same practical outcome (the account can never complete another sign-in — a disabled user's
 * tokens fail verification even before this check runs again) without destroying anything; an
 * admin can undo it by hand if the heuristic ever gets it wrong. Also exempts anonymous accounts
 * ("Continue as guest (testing)") — every anonymous sign-in is a fresh account by construction, so
 * enforcing this against them would silently break guest testing rather than gate real signups;
 * `admin/settings.signInMethods.anonymous` is the existing, deliberate on/off switch for that
 * button. Fails open on any unexpected error — a broken check should never be able to lock a real
 * user out, let alone disable one.
 */
export async function enforceSignupMode(uid: string, email: string): Promise<{ allowed: boolean }> {
  try {
    const settings = await getAdminSettings();
    if (settings.signupMode === "open") return { allowed: true };

    const bootstrapEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
    if (bootstrapEmail && email && email.toLowerCase() === bootstrapEmail.toLowerCase()) return { allowed: true };

    const userRecord = await adminAuth().getUser(uid);
    if (userRecord.providerData.length === 0) return { allowed: true }; // anonymous — see doc comment

    const isFirstSignIn = userRecord.metadata.creationTime === userRecord.metadata.lastSignInTime;
    if (!isFirstSignIn) return { allowed: true };

    if (settings.signupMode === "invite" && email) {
      const invite = await adminDb().collection("invites").doc(inviteId(email)).get();
      if (invite.exists) return { allowed: true };
    }

    await adminAuth().updateUser(uid, { disabled: true });
    await adminAuth().revokeRefreshTokens(uid);
    // The client's own `upsertUser` call already wrote users/{uid} before bootstrap ever ran, so
    // without this the account would sit in the admin Users table showing "active" (Role/Status
    // selects mirror this field, see D6) despite being unable to sign in, and `getActiveUids()`
    // (which treats a missing `status` as active) would keep including it in the daily cron.
    await adminDb().collection("users").doc(uid).set({ status: "disabled", updatedAt: new Date().toISOString() }, { merge: true });
    return { allowed: false };
  } catch {
    return { allowed: true };
  }
}
