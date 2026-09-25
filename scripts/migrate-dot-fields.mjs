#!/usr/bin/env node
/**
 * Repairs documents written before the plan/14 §12 fix to `saveDayFields`/`saveWeeklyReviewFields`
 * (lib/firestore.ts). Before that fix, a dot-path key like `"session.startedAt"` passed to
 * `setDoc(ref, data, {merge: true})` was NOT parsed as a field path — it created a literal
 * top-level field whose name contains the dot, sibling to the doc's real fields, instead of a
 * nested `session.startedAt`. Confirmed live: every `days/{date}` doc predating the fix holds
 * flat fields like `"session.startedAt"`, `"review.focusRating"`, `"rollup.taskDecisions.0"`
 * instead of real `session`/`review`/`rollup` objects — so `day.review?.focusRating` (the Look
 * back "Focus average" stat, among others) reads as if that data never existed, even though the
 * bytes are sitting right there under a mangled key. Same issue for `weeklyReviews/{weekStart}`'s
 * `"plan.*"` keys, dodging the pre-plan-14 docs entirely.
 *
 * This walks every user's `days` and `weeklyReviews` collections, finds any top-level field whose
 * name contains a literal dot, expands it into the real nested structure (merged with whatever
 * already-correct nested data exists at that path — a doc touched by both the old buggy code and
 * the new fixed code needs both merged, not one overwriting the other), writes the nested version,
 * and deletes the flat literal-named field via `FieldPath`'s single-segment literal form (a plain
 * string key would just re-split it into the same mistake `updateDoc` makes on write).
 *
 * Dry-run by default — only reads and writes a local JSON backup of every document this would
 * touch (before state only; the delete is exact and mechanical, so "before" is enough to reverse
 * by hand from the backup if something looks wrong). Pass --migrate to actually write.
 *
 * Usage:
 *   node scripts/migrate-dot-fields.mjs [--migrate] [--uid=<firebase-uid>]
 *
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment.
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldPath, FieldValue } from "firebase-admin/firestore";
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
const onlyUid = typeof args.uid === "string" ? args.uid : null;

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

/** Merges `value` into `target` at dotted `key`, deep-merging plain objects rather than replacing. */
function setDeep(target, key, value) {
  const parts = key.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof node[part] !== "object" || node[part] === null || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  const last = parts[parts.length - 1];
  if (value && typeof value === "object" && value.constructor === Object && typeof node[last] === "object" && node[last] !== null && !Array.isArray(node[last])) {
    Object.assign(node[last], value);
  } else {
    node[last] = value;
  }
}

async function fixCollection(uid, collectionName, backups) {
  const snapshot = await db.collection("users").doc(uid).collection(collectionName).get();
  let touched = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const dottedKeys = Object.keys(data).filter((key) => key.includes("."));
    if (dottedKeys.length === 0) continue;

    // Seed from a deep clone of whatever's already sitting at each touched root key — `update()`
    // replaces a plain (non-dotted) top-level field wholesale, so without this, a doc that already
    // has real nested data at that root (from a write made after the fix) would have that data
    // wiped by this migration instead of merged with it. (Caught live: a seeded `session.breaksTaken`
    // sibling vanished on the first version of this script that skipped this step.) Every value this
    // codebase's writers put in these fields is JSON-safe (ISO date strings, not Firestore
    // `Timestamp`s), so JSON round-tripping is a safe deep clone here.
    const nestedPatch = {};
    const rootKeys = new Set(dottedKeys.map((key) => key.split(".")[0]));
    for (const rootKey of rootKeys) {
      if (data[rootKey] && typeof data[rootKey] === "object" && data[rootKey].constructor === Object) {
        nestedPatch[rootKey] = JSON.parse(JSON.stringify(data[rootKey]));
      }
    }
    for (const key of dottedKeys) setDeep(nestedPatch, key, data[key]);

    backups.push({ uid, collection: collectionName, id: doc.id, before: data });
    touched += 1;
    console.log(`${doMigrate ? "Fixing" : "Would fix"} ${collectionName}/${doc.id} (uid ${uid}): ${dottedKeys.join(", ")}`);

    if (doMigrate) {
      await doc.ref.update(nestedPatch);
      // Object-form update() would re-split these dotted keys the same way the original bug did —
      // FieldPath's single-segment literal form is required to target the flat field by its real,
      // dotted, one-segment name.
      const deleteArgs = dottedKeys.flatMap((key) => [new FieldPath(key), FieldValue.delete()]);
      await doc.ref.update(...deleteArgs);
    }
  }
  return touched;
}

async function run() {
  const usersSnapshot = onlyUid ? { docs: [{ id: onlyUid }] } : await db.collection("users").get();
  const backups = [];
  let touched = 0;

  for (const userDoc of usersSnapshot.docs) {
    const uid = userDoc.id;
    touched += await fixCollection(uid, "days", backups);
    touched += await fixCollection(uid, "weeklyReviews", backups);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const backupDir = join(__dirname, "..", ".migration-backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `dot-fields-${nowIso().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify(backups, null, 2));

  console.log(`\n${touched} document(s) ${doMigrate ? "fixed" : "would be fixed"}. Backup: ${backupPath}`);
  if (!doMigrate) console.log("Dry run only — pass --migrate to write.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
