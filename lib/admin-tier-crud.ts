import { adminDb } from "@/lib/firebase-admin";
import { writeAuditEntry } from "@/lib/admin-audit";
import type { NewTier, Tier, TierLimits } from "@/types";

/**
 * Admin-panel CRUD over the `tiers` collection — the logic scripts/manage-tiers.mjs
 * has been exercising directly via the Admin SDK since Phase 4. This module is
 * that same logic, reused by both the script (kept as a stopgap CLI) and the
 * real /api/admin/tiers* routes (§3.3, §4.7 of the admin panel spec), now with
 * audit-log writes attached to every mutation.
 */

export async function listTiersWithUserCounts(): Promise<(Tier & { userCount: number })[]> {
  const snapshot = await adminDb().collection("tiers").get();
  const tiers = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Tier);
  const defaultTier = tiers.find((tier) => tier.isDefault);

  const counts = await Promise.all(
    tiers.map(async (tier) => {
      const assigned = await adminDb().collection("users").where("tierId", "==", tier.id).count().get();
      let count = assigned.data().count;
      if (tier.id === defaultTier?.id) {
        const unassigned = await adminDb().collection("users").where("tierId", "==", null).count().get();
        count += unassigned.data().count;
      }
      return count;
    })
  );

  return tiers.map((tier, index) => ({ ...tier, userCount: counts[index] }));
}

async function clearExistingDefault(): Promise<void> {
  const snapshot = await adminDb().collection("tiers").where("isDefault", "==", true).get();
  await Promise.all(snapshot.docs.map((doc) => doc.ref.set({ isDefault: false, updatedAt: new Date().toISOString() }, { merge: true })));
}

export async function createTier(actor: { uid: string; email: string }, input: NewTier): Promise<string> {
  if (input.isDefault) await clearExistingDefault();
  const now = new Date().toISOString();
  const ref = await adminDb()
    .collection("tiers")
    .add({ ...input, createdAt: now, updatedAt: now, updatedBy: actor.uid });
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "tier.create", targetType: "tier", targetId: ref.id, after: input });
  return ref.id;
}

export async function updateTier(
  actor: { uid: string; email: string },
  tierId: string,
  patch: Partial<{ name: string; description: string; limits: TierLimits; allowedModels: Tier["allowedModels"] }>
): Promise<void> {
  const ref = adminDb().collection("tiers").doc(tierId);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`No tier with id ${tierId}.`);
  const before = existing.data();
  await ref.set({ ...patch, updatedAt: new Date().toISOString(), updatedBy: actor.uid }, { merge: true });
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "tier.update", targetType: "tier", targetId: tierId, before, after: patch });
}

export async function setDefaultTier(actor: { uid: string; email: string }, tierId: string): Promise<void> {
  const ref = adminDb().collection("tiers").doc(tierId);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`No tier with id ${tierId}.`);
  await clearExistingDefault();
  await ref.set({ isDefault: true, updatedAt: new Date().toISOString(), updatedBy: actor.uid }, { merge: true });
  await writeAuditEntry({ actorUid: actor.uid, actorEmail: actor.email, action: "tier.set-default", targetType: "tier", targetId: tierId });
}

export class DefaultTierDeleteError extends Error {}

export async function deleteTier(actor: { uid: string; email: string }, tierId: string): Promise<{ reassignedUserCount: number }> {
  const ref = adminDb().collection("tiers").doc(tierId);
  const existing = await ref.get();
  if (!existing.exists) throw new Error(`No tier with id ${tierId}.`);
  if (existing.data()?.isDefault) {
    throw new DefaultTierDeleteError("The default tier cannot be deleted — set a different tier as default first.");
  }

  const affected = await adminDb().collection("users").where("tierId", "==", tierId).get();
  await Promise.all(affected.docs.map((doc) => doc.ref.set({ tierId: null, updatedAt: new Date().toISOString() }, { merge: true })));
  await ref.delete();

  await writeAuditEntry({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action: "tier.delete",
    targetType: "tier",
    targetId: tierId,
    before: existing.data(),
    after: { reassignedUserCount: affected.size }
  });

  return { reassignedUserCount: affected.size };
}

export async function assignUserTier(actor: { uid: string; email: string }, uid: string, tierId: string | null): Promise<void> {
  let limits: TierLimits | undefined;
  if (tierId) {
    const tierDoc = await adminDb().collection("tiers").doc(tierId).get();
    if (!tierDoc.exists) throw new Error(`No tier with id ${tierId}.`);
    limits = tierDoc.data()?.limits as TierLimits;
  }

  const userRef = adminDb().collection("users").doc(uid);
  const before = (await userRef.get()).data();
  await userRef.set(
    {
      tierId,
      monthlyBudgetUsd: limits?.aiMonthlyBudgetUsd,
      blobQuotaMb: limits?.blobQuotaMb,
      updatedAt: new Date().toISOString()
    },
    { merge: true }
  );

  await writeAuditEntry({
    actorUid: actor.uid,
    actorEmail: actor.email,
    action: "user.tier.change",
    targetType: "user",
    targetId: uid,
    before: { tierId: before?.tierId },
    after: { tierId }
  });
}
