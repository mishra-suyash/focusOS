#!/usr/bin/env node
/**
 * Pre-admin-panel tier management. Tiers (`tiers/{tierId}`) are a top-level,
 * admin-managed collection — dynamic, not a hardcoded enum, per the design in
 * plan/FocusOS-v2-Admin-Panel.md's Tiers section. Firestore rules make the
 * collection write-only via the Admin SDK, so until the real `/admin/tiers`
 * screen exists (Phase 4.5), this script IS the admin UI.
 *
 * Usage:
 *   node scripts/manage-tiers.mjs list
 *   node scripts/manage-tiers.mjs create --name="Free" --default \
 *     --maxRevisionsPerDay=20 --maxRevisionMinutesPerDay=45 \
 *     --aiMonthlyBudgetUsd=5 --blobQuotaMb=800 --allowedModels=claude,gemini
 *   node scripts/manage-tiers.mjs update --id=<tierId> --aiMonthlyBudgetUsd=10
 *   node scripts/manage-tiers.mjs set-default --id=<tierId>
 *   node scripts/manage-tiers.mjs delete --id=<tierId>
 *   node scripts/manage-tiers.mjs assign --uid=<firebase-uid> --tierId=<tierId>
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment.
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const [, , command, ...rest] = process.argv;
const args = Object.fromEntries(
  rest.map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  })
);

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
  process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

function nowIso() {
  return new Date().toISOString();
}

function printUsage() {
  console.error(
    [
      "Usage:",
      "  node scripts/manage-tiers.mjs list",
      '  node scripts/manage-tiers.mjs create --name="Free" [--default] [--maxRevisionsPerDay=20] [--maxRevisionMinutesPerDay=45] [--aiMonthlyBudgetUsd=5] [--blobQuotaMb=800] [--allowedModels=claude,gemini]',
      "  node scripts/manage-tiers.mjs update --id=<tierId> [any of the above fields]",
      "  node scripts/manage-tiers.mjs set-default --id=<tierId>",
      "  node scripts/manage-tiers.mjs delete --id=<tierId>",
      "  node scripts/manage-tiers.mjs assign --uid=<firebase-uid> --tierId=<tierId>"
    ].join("\n")
  );
}

function limitsFromArgs(existing = {}) {
  const limits = { ...existing };
  if (args.maxRevisionsPerDay !== undefined) limits.maxRevisionsPerDay = Number(args.maxRevisionsPerDay);
  if (args.maxRevisionMinutesPerDay !== undefined) limits.maxRevisionMinutesPerDay = Number(args.maxRevisionMinutesPerDay);
  if (args.aiMonthlyBudgetUsd !== undefined) limits.aiMonthlyBudgetUsd = Number(args.aiMonthlyBudgetUsd);
  if (args.blobQuotaMb !== undefined) limits.blobQuotaMb = Number(args.blobQuotaMb);
  return limits;
}

async function listTiers() {
  const snapshot = await db.collection("tiers").get();
  if (snapshot.empty) {
    console.log("No tiers exist yet — every account uses the hardcoded fallback limits (see lib/tier-defaults.ts).");
    return;
  }
  for (const doc of snapshot.docs) {
    const tier = doc.data();
    console.log(`${doc.id}${tier.isDefault ? " (default)" : ""}: ${tier.name}`);
    console.log(`  limits: ${JSON.stringify(tier.limits)}`);
    console.log(`  allowedModels: ${(tier.allowedModels ?? []).join(", ") || "(none)"}`);
  }
}

async function createTier() {
  if (!args.name) {
    console.error("--name is required.");
    process.exit(1);
  }
  const isDefault = Boolean(args.default);
  if (isDefault) await clearExistingDefault();

  const limits = limitsFromArgs({ maxRevisionsPerDay: 20, maxRevisionMinutesPerDay: 45, aiMonthlyBudgetUsd: 5, blobQuotaMb: 800 });
  const allowedModels = args.allowedModels ? args.allowedModels.split(",").map((m) => m.trim()) : ["claude", "gemini"];

  const ref = await db.collection("tiers").add({
    name: args.name,
    description: args.description || undefined,
    isDefault,
    limits,
    allowedModels,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  console.log(`Created tier ${ref.id} ("${args.name}").`);
}

async function updateTier() {
  if (!args.id) {
    console.error("--id is required.");
    process.exit(1);
  }
  const ref = db.collection("tiers").doc(args.id);
  const existing = await ref.get();
  if (!existing.exists) {
    console.error(`No tier with id ${args.id}.`);
    process.exit(1);
  }
  const patch = { updatedAt: nowIso() };
  if (args.name) patch.name = args.name;
  if (args.description) patch.description = args.description;
  const limits = limitsFromArgs(existing.data().limits ?? {});
  if (Object.keys(limits).length > 0) patch.limits = limits;
  if (args.allowedModels) patch.allowedModels = args.allowedModels.split(",").map((m) => m.trim());
  await ref.set(patch, { merge: true });
  console.log(`Updated tier ${args.id}.`);
}

async function clearExistingDefault() {
  const snapshot = await db.collection("tiers").where("isDefault", "==", true).get();
  await Promise.all(snapshot.docs.map((doc) => doc.ref.set({ isDefault: false, updatedAt: nowIso() }, { merge: true })));
}

async function setDefaultTier() {
  if (!args.id) {
    console.error("--id is required.");
    process.exit(1);
  }
  const ref = db.collection("tiers").doc(args.id);
  const existing = await ref.get();
  if (!existing.exists) {
    console.error(`No tier with id ${args.id}.`);
    process.exit(1);
  }
  await clearExistingDefault();
  await ref.set({ isDefault: true, updatedAt: nowIso() }, { merge: true });
  console.log(`Tier ${args.id} is now the default.`);
}

async function deleteTier() {
  if (!args.id) {
    console.error("--id is required.");
    process.exit(1);
  }
  const ref = db.collection("tiers").doc(args.id);
  const existing = await ref.get();
  if (!existing.exists) {
    console.error(`No tier with id ${args.id}.`);
    process.exit(1);
  }
  if (existing.data().isDefault) {
    console.error("Refusing to delete the default tier — set a different tier as default first (set-default), or every user with no explicit tierId will fall back to the hardcoded defaults, which may not be what you want silently.");
    process.exit(1);
  }
  const affected = await db.collection("users").where("tierId", "==", args.id).get();
  await ref.delete();
  console.log(`Deleted tier ${args.id}.`);
  if (!affected.empty) {
    console.log(`${affected.size} user(s) were on this tier and now fall back to whichever tier is marked default (or the hardcoded fallback if none is). Re-run "assign" for any of them that need a specific tier:`);
    affected.docs.forEach((doc) => console.log(`  ${doc.id}`));
  }
}

async function assignUser() {
  if (!args.uid) {
    console.error("--uid is required.");
    process.exit(1);
  }
  if (args.tierId) {
    const tierDoc = await db.collection("tiers").doc(args.tierId).get();
    if (!tierDoc.exists) {
      console.error(`No tier with id ${args.tierId}.`);
      process.exit(1);
    }
  }
  await db.collection("users").doc(args.uid).set({ tierId: args.tierId || null, updatedAt: nowIso() }, { merge: true });
  console.log(args.tierId ? `Assigned ${args.uid} to tier ${args.tierId}.` : `Cleared ${args.uid}'s tier assignment (falls back to the default tier).`);
}

async function main() {
  switch (command) {
    case "list":
      return listTiers();
    case "create":
      return createTier();
    case "update":
      return updateTier();
    case "set-default":
      return setDefaultTier();
    case "delete":
      return deleteTier();
    case "assign":
      return assignUser();
    default:
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
