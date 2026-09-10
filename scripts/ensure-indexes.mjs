#!/usr/bin/env node
/**
 * Applies every index listed in firestore.indexes.json directly via the
 * Firestore Admin REST API, using the same service account as the other
 * scripts. This is a stand-in for `firebase deploy --only firestore:indexes`
 * for anyone who hasn't set up the Firebase CLI locally. Safe to re-run —
 * Firestore returns ALREADY_EXISTS for a duplicate and this script treats
 * that as success.
 *
 * Usage: node scripts/ensure-indexes.mjs
 * Requires FIREBASE_SERVICE_ACCOUNT_BASE64 in the environment.
 */
import { GoogleAuth } from "google-auth-library";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encoded) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. Export it before running this script.");
  process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
const auth = new GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexesPath = join(__dirname, "..", "firestore.indexes.json");
const { indexes } = JSON.parse(readFileSync(indexesPath, "utf-8"));

async function main() {
  if (indexes.length === 0) {
    console.log("No indexes listed in firestore.indexes.json.");
    return;
  }

  const token = await auth.getAccessToken();
  const projectId = serviceAccount.project_id;

  for (const index of indexes) {
    const { collectionGroup, ...body } = index;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/${collectionGroup}/indexes`;
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (response.ok) {
      console.log(`Created index on ${collectionGroup}: ${body.fields.map((f) => `${f.fieldPath} ${f.order}`).join(", ")}`);
      console.log(`  ${data.name} (building — usually ready within a minute or two)`);
    } else if (data.error?.status === "ALREADY_EXISTS" || (data.error?.message ?? "").includes("already exists")) {
      console.log(`Index on ${collectionGroup} already exists, skipping.`);
    } else if (data.error?.status === "PERMISSION_DENIED") {
      console.error(
        `Permission denied creating the index on ${collectionGroup}. The service account needs the "Cloud Datastore Index Admin" ` +
          `(or Editor/Owner) IAM role on this GCP project — grant it in the Cloud Console, or just run the app and click the ` +
          `"create index" link Firestore prints in the browser console the first time this query runs; either creates the same index.`
      );
    } else {
      console.error(`Failed to create index on ${collectionGroup}:`, data.error ?? data);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
