#!/usr/bin/env node
/**
 * Phase 1 data migration: converts the old flat `courseAssignments` collection
 * into `courses/{courseId}/checkpoints/{checkpointId}` docs with
 * `type: 'assignment'`, per the v2 schema (an assignment is just a checkpoint).
 *
 * Dry-run by default — only reads and writes a local JSON backup. Pass
 * --migrate to actually write the checkpoint docs, and --delete to remove the
 * old courseAssignments documents afterwards (only ever after a successful
 * backup).
 *
 * Usage:
 *   node scripts/migrate-phase1.mjs --uid=<firebase-uid> [--migrate] [--delete]
 *
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

const uid = args.uid;
if (!uid) {
  console.error("Usage: node scripts/migrate-phase1.mjs --uid=<firebase-uid> [--migrate] [--delete]");
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

async function main() {
  console.log(`Phase 1 migration for uid=${uid} (migrate=${doMigrate}, delete=${doDelete})\n`);

  const snapshot = await db.collection("users").doc(uid).collection("courseAssignments").get();
  const assignments = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  console.log(`  read courseAssignments: ${assignments.length} doc(s)`);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const backupDir = join(__dirname, "..", ".migration-backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `phase1-${uid}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({ courseAssignments: assignments }, null, 2));
  console.log(`\nBackup written to ${backupPath}`);

  if (!doMigrate) {
    console.log("\nDry run only (no --migrate flag). Re-run with --migrate to write checkpoint docs.");
    return;
  }

  const dropped = [];
  let created = 0;
  for (const assignment of assignments) {
    if (!assignment.courseId) {
      console.log(`  skipping ${assignment.id}: no courseId`);
      continue;
    }
    const statusMap = { todo: "upcoming", in_progress: "prepping", done: "done" };
    const checkpoint = {
      courseId: assignment.courseId,
      type: "assignment",
      title: assignment.title ?? "Untitled assignment",
      dueAt: assignment.dueDate ?? new Date().toISOString().slice(0, 10),
      weightPct: assignment.weight,
      requiresPrep: false,
      prepLeadDays: 5,
      prepEstimateMin: 180,
      topicIds: [],
      status: statusMap[assignment.status] ?? "upcoming",
      createdAt: assignment.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await db
      .collection("users")
      .doc(uid)
      .collection("courses")
      .doc(assignment.courseId)
      .collection("checkpoints")
      .add(Object.fromEntries(Object.entries(checkpoint).filter(([, v]) => v !== undefined)));
    created += 1;
    if (assignment.grade || assignment.notes) {
      dropped.push({ id: assignment.id, title: assignment.title, grade: assignment.grade, notes: assignment.notes });
    }
  }
  console.log(`\nCreated ${created} checkpoint(s).`);
  if (dropped.length > 0) {
    console.log(`\nNote: ${dropped.length} assignment(s) had a grade/notes field with no equivalent on Checkpoint (result.score/max is numeric only). Preserved in the backup JSON only:`);
    for (const item of dropped) console.log(`  ${item.title}: grade=${item.grade ?? "-"} notes=${item.notes ?? "-"}`);
  }

  if (!doDelete) {
    console.log("\nOld courseAssignments left in place (no --delete flag). Re-run with --delete once you've verified the checkpoints look right.");
    return;
  }

  for (const assignment of assignments) {
    await db.collection("users").doc(uid).collection("courseAssignments").doc(assignment.id).delete();
  }
  console.log(`\nDeleted ${assignments.length} courseAssignments doc(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
