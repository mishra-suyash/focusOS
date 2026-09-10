#!/usr/bin/env node
/**
 * Phase 3 data migration: backfills pre-Phase-3 `papers` docs (created before
 * goal/goalKind/pass1-3/progress/groupIds existed) with the new fields,
 * synthesizing pass completion from the old flat `status` so the reading
 * workflow and progress bar render sensibly instead of showing "to read" for
 * every paper you'd already finished. This never invents a reading goal —
 * `goal`/`goalKind` are left unset on migrated docs, since starting Pass 1
 * again is the natural place to prompt for them.
 *
 * Status mapping (best-effort, since the old schema recorded no pass detail):
 *   to_read  -> unchanged, progress 0
 *   reading  -> pass1 done (verdict "continue"), progress 33
 *   read     -> pass1 + pass2 done (outcome "grasped"), progress 66
 *   archived -> pass1 done (verdict "drop"), progress 0
 *
 * Dry-run by default — only reads and writes a local JSON backup. Pass
 * --migrate to actually patch the docs.
 *
 * Usage: node scripts/migrate-phase3.mjs --uid=<firebase-uid> [--migrate]
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
  console.error("Usage: node scripts/migrate-phase3.mjs --uid=<firebase-uid> [--migrate]");
  process.exit(1);
}
const doMigrate = Boolean(args.migrate);

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

function backfillFor(paper) {
  if (typeof paper.progress === "number" && (paper.pass1 || paper.pass2 || paper.pass3 || paper.status === "to_read")) {
    return null; // already Phase-3 shaped, or genuinely untouched — nothing to do
  }
  const patch = { groupIds: paper.groupIds ?? [] };
  const doneAt = paper.readAt ?? nowIso();

  if (paper.status === "reading") {
    patch.pass1 = { status: "done", startedAt: doneAt, completedAt: doneAt, output: { steps: {}, contributions: [], referencesAlreadyRead: [], verdict: "continue", verdictReason: "proceeding" } };
    patch.progress = 33;
  } else if (paper.status === "read") {
    patch.pass1 = { status: "done", startedAt: doneAt, completedAt: doneAt, output: { steps: {}, contributions: [], referencesAlreadyRead: [], verdict: "continue", verdictReason: "proceeding" } };
    patch.pass2 = { status: "done", startedAt: doneAt, completedAt: doneAt, output: { keyPoints: [], figures: [], unreadReferencesMarked: [], summary: "(migrated from pre-Phase-3 data — no summary recorded)", unclear: [], outcome: "grasped" } };
    patch.progress = 66;
  } else if (paper.status === "archived") {
    patch.pass1 = { status: "done", startedAt: doneAt, completedAt: doneAt, output: { steps: {}, contributions: [], referencesAlreadyRead: [], verdict: "drop", verdictReason: "not-interested" } };
    patch.progress = 0;
  } else {
    patch.progress = 0;
  }
  return patch;
}

async function main() {
  console.log(`Phase 3 migration for uid=${uid} (migrate=${doMigrate})\n`);

  const snapshot = await db.collection("users").doc(uid).collection("papers").get();
  const papers = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  console.log(`  read papers: ${papers.length} doc(s)`);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const backupDir = join(__dirname, "..", ".migration-backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `phase3-${uid}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify({ papers }, null, 2));
  console.log(`\nBackup written to ${backupPath}`);

  const toPatch = papers.map((paper) => ({ paper, patch: backfillFor(paper) })).filter(({ patch }) => patch);
  console.log(`\n${toPatch.length} of ${papers.length} paper(s) need backfilling.`);

  if (!doMigrate) {
    console.log("\nDry run only (no --migrate flag). Re-run with --migrate to apply.");
    return;
  }

  for (const { paper, patch } of toPatch) {
    await db.collection("users").doc(uid).collection("papers").doc(paper.id).set({ ...patch, updatedAt: nowIso() }, { merge: true });
  }
  console.log(`\nBackfilled ${toPatch.length} paper(s). Migrated docs have no goal/goalKind set — you'll be prompted when you next start a pass on one.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
