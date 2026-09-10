#!/usr/bin/env node
/**
 * Phase 0 data migration: merges the old dailyNotes/dailyPlans/dailyReviews/
 * workdaySessions collections into one days/{date} document per the new
 * schema, and backs up (then optionally deletes) the collections that Phase 0
 * cuts outright: thoughts, thoughtSelections, weeklyGoals, plus the four
 * merged-away collections above.
 *
 * Dry-run by default — it only reads and writes a local JSON backup. Pass
 * --migrate to actually write the merged days/{date} docs, and --delete to
 * remove the old documents afterwards (only ever after a successful backup).
 *
 * Usage:
 *   node scripts/migrate-phase0.mjs --uid=<firebase-uid> [--migrate] [--delete]
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment (the same
 * variable the app's own AI insights route uses) — export it in your shell
 * before running, e.g.:
 *   export FIREBASE_SERVICE_ACCOUNT_BASE64=$(base64 -i serviceAccountKey.json)
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

const uid = args.uid;
if (!uid) {
  console.error("Usage: node scripts/migrate-phase0.mjs --uid=<firebase-uid> [--migrate] [--delete]");
  process.exit(1);
}

const doMigrate = Boolean(args.migrate);
const doDelete = Boolean(args.delete);

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
  process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
const app = initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

const CUT_COLLECTIONS = ["thoughts", "thoughtSelections", "weeklyGoals"];
const MERGED_COLLECTIONS = ["dailyNotes", "dailyPlans", "dailyReviews", "workdaySessions"];

async function fetchAll(name) {
  const snapshot = await db.collection("users").doc(uid).collection(name).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function main() {
  console.log(`Phase 0 migration for uid=${uid} (migrate=${doMigrate}, delete=${doDelete})\n`);

  const backup = {};
  for (const name of [...CUT_COLLECTIONS, ...MERGED_COLLECTIONS]) {
    backup[name] = await fetchAll(name);
    console.log(`  read ${name}: ${backup[name].length} doc(s)`);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const backupDir = join(__dirname, "..", ".migration-backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `phase0-${uid}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written to ${backupPath}`);

  if (!doMigrate) {
    console.log("\nDry run only (no --migrate flag). Nothing was written to Firestore. Re-run with --migrate to merge into days/{date}.");
    return;
  }

  const dayNotesByDate = Object.fromEntries(backup.dailyNotes.map((note) => [note.id, note]));
  const dayReviewsByDate = Object.fromEntries(backup.dailyReviews.map((review) => [review.id, review]));
  const daySessionsByDate = Object.fromEntries(backup.workdaySessions.map((session) => [session.id, session]));
  const dates = new Set([...Object.keys(dayNotesByDate), ...Object.keys(dayReviewsByDate), ...Object.keys(daySessionsByDate)]);

  let merged = 0;
  const skippedPriorities = [];
  for (const plan of backup.dailyPlans) {
    if (Array.isArray(plan.priorities) && plan.priorities.some(Boolean)) {
      skippedPriorities.push({ date: plan.id, priorities: plan.priorities });
    }
  }

  for (const date of dates) {
    const note = dayNotesByDate[date];
    const review = dayReviewsByDate[date];
    const session = daySessionsByDate[date];
    const fields = { date, updatedAt: new Date().toISOString() };
    if (note?.content) fields.scratchpad = note.content;
    if (review) {
      fields.review = {
        done: review.done ?? "",
        blocked: review.blocked ?? "",
        carryForward: review.carryForward ?? "",
        focusRating: review.focusRating,
        energyRating: review.energyRating,
        submittedAt: review.updatedAt
      };
    }
    if (session) {
      fields.session = {
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        hydrationCount: session.hydrationCount ?? 0,
        breaksTaken: session.breaksTaken ?? 0,
        lastHydrationAt: session.lastHydrationAt,
        lastBreakPromptAt: session.lastBreakPromptAt
      };
    }
    await db.collection("users").doc(uid).collection("days").doc(date).set(fields, { merge: true });
    merged += 1;
  }
  console.log(`\nMerged ${merged} day(s) into users/${uid}/days/{date}.`);

  if (skippedPriorities.length > 0) {
    console.log(
      `\nNote: ${skippedPriorities.length} old dailyPlans doc(s) had free-text "Top 3 priorities" that cannot be auto-converted to pinned task ids (they aren't real tasks). They're preserved in the backup JSON — re-pin manually if you want them back:`
    );
    for (const { date, priorities } of skippedPriorities) {
      console.log(`  ${date}: ${priorities.filter(Boolean).join(" | ")}`);
    }
  }

  if (!doDelete) {
    console.log("\nOld collections left in place (no --delete flag). Re-run with --delete once you've verified the merged days look right.");
    return;
  }

  for (const name of [...CUT_COLLECTIONS, ...MERGED_COLLECTIONS]) {
    const docs = backup[name];
    for (const item of docs) {
      await db.collection("users").doc(uid).collection(name).doc(item.id).delete();
    }
    console.log(`  deleted ${docs.length} doc(s) from ${name}`);
  }
  console.log("\nDone. Old collections removed; backup JSON is the only remaining copy of the cut data.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
