#!/usr/bin/env node
/**
 * U0 migration (plan §10.2): backfills `meta/settings.packId` +
 * `onboarding.status` for every existing user, so the U3 onboarding flow
 * (not yet built) never re-runs for an account that already has real usage,
 * and U4's module gating defaults such an account to every feature it
 * already has (packId "everything").
 *
 * Principle: existing users keep every feature they have — only the
 * vocabulary changes for them. An account counts as "existing" if it has any
 * task, day template, course, paper, or focus session, or if its profile's
 * `createdAt` predates `--cutoff` (default: now, i.e. every account that
 * exists before this migration runs). Everyone else is left untouched — the
 * client-side check in `hooks/use-user-settings.ts` consumers is only meant
 * as a safety net, this script is the primary path.
 *
 * Dry-run by default — only reads and writes a local JSON backup of the
 * `meta/settings` doc for every user this would touch. Pass --migrate to
 * actually write the packId/onboarding fields.
 *
 * Usage: node scripts/migrate-ux.mjs [--migrate] [--cutoff=2026-09-10]
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment.
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? true];
  })
);

const doMigrate = Boolean(args.migrate);
const cutoff = typeof args.cutoff === "string" ? args.cutoff : new Date().toISOString();

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
  process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

const USAGE_COLLECTIONS = ["tasks", "dayTemplates", "courses", "papers", "pomodoroSessions"];

function nowIso() {
  return new Date().toISOString();
}

async function hasAnyUsage(uid) {
  for (const name of USAGE_COLLECTIONS) {
    const snapshot = await db.collection("users").doc(uid).collection(name).limit(1).get();
    if (!snapshot.empty) return true;
  }
  return false;
}

async function run() {
  const usersSnapshot = await db.collection("users").get();
  const backups = [];
  let touched = 0;
  let skipped = 0;

  for (const userDoc of usersSnapshot.docs) {
    const uid = userDoc.id;
    const settingsRef = db.collection("users").doc(uid).collection("meta").doc("settings");
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};

    if (settings.packId) {
      skipped += 1;
      continue; // already migrated or onboarded
    }

    const profile = userDoc.data();
    const isExisting = (await hasAnyUsage(uid)) || (typeof profile.createdAt === "string" && profile.createdAt < cutoff);
    if (!isExisting) {
      skipped += 1;
      continue; // genuinely new — leave packId unset so U3's onboarding runs
    }

    backups.push({ uid, before: settings });
    touched += 1;
    console.log(`${doMigrate ? "Migrating" : "Would migrate"} ${uid} -> packId: "everything", onboarding.status: "done"`);

    if (doMigrate) {
      await settingsRef.set(
        { packId: "everything", onboarding: { status: "done", completedAt: nowIso() }, updatedAt: nowIso() },
        { merge: true }
      );
    }
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const backupDir = join(__dirname, "..", ".migration-backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `ux-settings-${nowIso().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify(backups, null, 2));

  console.log(`\n${touched} account(s) ${doMigrate ? "migrated" : "would be migrated"}, ${skipped} skipped. Backup: ${backupPath}`);
  if (!doMigrate) console.log("Dry run only — pass --migrate to write.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
