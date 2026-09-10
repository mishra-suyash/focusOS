import { adminDb } from "@/lib/firebase-admin";
import { writeAuditEntry } from "@/lib/admin-audit";

/**
 * Invited-but-not-yet-signed-in users, keyed by lowercased email (not uid,
 * since the uid doesn't exist until they sign in). Claimed automatically the
 * first time that email signs in — see claimInviteIfAny, called alongside
 * bootstrapOwnerIfNeeded from POST /api/admin/bootstrap.
 */

function inviteId(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
}

export async function createInvite(actor: { uid: string; email: string }, email: string, tierId?: string): Promise<void> {
  await adminDb()
    .collection("invites")
    .doc(inviteId(email))
    .set({ email: email.toLowerCase(), status: "invited", tierId, invitedBy: actor.uid, createdAt: new Date().toISOString() });
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "user.invite", targetType: "user", targetId: email });
}

/** Copies the invite's tier onto the newly signed-in uid and deletes the invite doc. No-op if no invite exists for this email. */
export async function claimInviteIfAny(uid: string, email: string): Promise<void> {
  if (!email) return;
  const ref = adminDb().collection("invites").doc(inviteId(email));
  const snapshot = await ref.get();
  if (!snapshot.exists) return;

  const invite = snapshot.data();
  await adminDb()
    .collection("users")
    .doc(uid)
    .set({ tierId: invite?.tierId ?? null, status: "active", updatedAt: new Date().toISOString() }, { merge: true });
  await ref.delete();
}

export { inviteId };
