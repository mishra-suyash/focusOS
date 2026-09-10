import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { writeAuditEntry } from "@/lib/admin-audit";
import { setUserRole, RoleChangeError } from "@/lib/admin-roles";
import type { UserProfile, UserRole, UserStatus } from "@/types";

/** Safety cap on how many uids a single cron tick will process — matches maxActiveUsers' intent (§6 of the admin panel spec). */
const ACTIVE_UID_QUERY_LIMIT = 200;

/**
 * Uids the daily cron and any other unattended job should process. Replaces
 * the OWNER_UIDS allowlist: a user with no `status` field (every pre-Phase-4.5
 * account) is treated as active, so this never silently drops an existing user
 * on rollout. Disabled users are excluded at the query, not filtered after.
 */
export async function getActiveUids(): Promise<string[]> {
  const snapshot = await adminDb().collection("users").where("status", "!=", "disabled").limit(ACTIVE_UID_QUERY_LIMIT).get();
  const withStatus = new Set(snapshot.docs.map((doc) => doc.id));
  const withoutStatus = await adminDb().collection("users").limit(ACTIVE_UID_QUERY_LIMIT).get();
  withoutStatus.docs.forEach((doc) => {
    if (doc.data().status === undefined) withStatus.add(doc.id);
  });
  return Array.from(withStatus);
}

/** Every uid, bounded — used by the overview screen's cross-user aggregates, which read each user's own usage/files docs directly rather than a Firestore collectionGroup query (avoiding the extra collection-group indexes that would otherwise be required). */
export async function listAllUids(limit = 200): Promise<string[]> {
  const snapshot = await adminDb().collection("users").select().limit(limit).get();
  return snapshot.docs.map((doc) => doc.id);
}

export interface ListUsersOptions {
  cursor?: string;
  limit?: number;
  role?: UserRole;
  status?: UserStatus;
  tierId?: string;
  search?: string;
}

export interface ListUsersResult {
  users: UserProfile[];
  nextCursor?: string;
}

export async function listUsers(options: ListUsersOptions): Promise<ListUsersResult> {
  const pageSize = Math.min(options.limit ?? 25, 100);
  let query: FirebaseFirestore.Query = adminDb().collection("users");

  if (options.role) query = query.where("role", "==", options.role);
  if (options.status) query = query.where("status", "==", options.status);
  if (options.tierId) query = query.where("tierId", "==", options.tierId);
  if (options.search) {
    const term = options.search.toLowerCase();
    query = query.orderBy("email").startAt(term).endAt(`${term}`);
  } else {
    query = query.orderBy("createdAt", "desc");
  }
  if (options.cursor) {
    const cursorDoc = await adminDb().collection("users").doc(options.cursor).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }

  const snapshot = await query.limit(pageSize).get();
  const users = snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }) as UserProfile);
  return { users, nextCursor: snapshot.docs.length === pageSize ? snapshot.docs[snapshot.docs.length - 1].id : undefined };
}

export interface PatchUserInput {
  role?: UserRole;
  status?: UserStatus;
  aiEnabled?: boolean;
  monthlyBudgetUsd?: number;
  blobQuotaMb?: number;
  notes?: string;
}

export async function patchUser(
  actor: { uid: string; email: string; role: UserRole },
  targetUid: string,
  patch: PatchUserInput
): Promise<void> {
  const targetRef = adminDb().collection("users").doc(targetUid);
  const targetSnapshot = await targetRef.get();
  const before = targetSnapshot.exists ? (targetSnapshot.data() as UserProfile) : undefined;

  if (before?.role === "owner" && (patch.role !== undefined || patch.status !== undefined)) {
    throw new RoleChangeError("The owner's role and status cannot be changed by anyone, including the owner.");
  }

  // Disabling is authorised from the `role` claim (verifyActiveUser checks role
  // === "disabled"), not the `status` field, which is display data only — but
  // the admin screen lets an admin toggle either one, so keep them in lockstep
  // no matter which one was the actual patch: disabling status also disables
  // the role claim, and setting role to "disabled" also flips status. Coming
  // back from disabled always lands on "member" — re-promoting to admin is a
  // separate, deliberate action, never something a re-enable silently restores.
  const wasDisabled = before?.role === "disabled";
  let resolvedRole = patch.role;
  let resolvedStatus = patch.status;

  if (patch.status === "disabled" && resolvedRole === undefined) resolvedRole = "disabled";
  if (patch.status === "active" && resolvedRole === undefined && wasDisabled) resolvedRole = "member";
  if (patch.role === "disabled" && resolvedStatus === undefined) resolvedStatus = "disabled";
  if (patch.role !== undefined && patch.role !== "disabled" && wasDisabled && resolvedStatus === undefined) resolvedStatus = "active";

  if (resolvedRole !== undefined) {
    await setUserRole(actor, targetUid, resolvedRole);
  }

  const { role: _role, status: _status, ...rest } = patch;
  void _role;
  void _status;
  if (Object.keys(rest).length > 0 || resolvedStatus !== undefined) {
    await targetRef.set({ ...rest, ...(resolvedStatus !== undefined ? { status: resolvedStatus } : {}), updatedAt: new Date().toISOString() }, { merge: true });
  }

  if (resolvedStatus !== undefined && resolvedStatus !== before?.status) {
    await writeAuditEntry({
      actorUid: actor.uid,
      actorEmail: actor.email,
      action: resolvedStatus === "disabled" ? "user.disable" : "user.enable",
      targetType: "user",
      targetId: targetUid,
      before: { status: before?.status },
      after: { status: resolvedStatus }
    });
    if (resolvedStatus === "disabled") await adminAuth().revokeRefreshTokens(targetUid);
  }

  if (patch.monthlyBudgetUsd !== undefined || patch.blobQuotaMb !== undefined) {
    await writeAuditEntry({
      actorUid: actor.uid,
      actorEmail: actor.email,
      action: "user.budget.change",
      targetType: "user",
      targetId: targetUid,
      before: { monthlyBudgetUsd: before?.monthlyBudgetUsd, blobQuotaMb: before?.blobQuotaMb },
      after: { monthlyBudgetUsd: patch.monthlyBudgetUsd, blobQuotaMb: patch.blobQuotaMb }
    });
  }
}

/** Effective per-user AI budget cap: the user's override if set, else the tier's limit (resolved by the caller). */
export async function effectiveUserOverrides(uid: string): Promise<{ aiEnabled: boolean; monthlyBudgetUsd?: number; blobQuotaMb?: number }> {
  const snapshot = await adminDb().collection("users").doc(uid).get();
  const data = snapshot.exists ? (snapshot.data() as UserProfile) : undefined;
  return {
    aiEnabled: data?.aiEnabled ?? true,
    monthlyBudgetUsd: data?.monthlyBudgetUsd,
    blobQuotaMb: data?.blobQuotaMb
  };
}
