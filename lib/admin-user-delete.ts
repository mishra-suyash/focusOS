import { del, list, put } from "@vercel/blob";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { writeAuditEntry } from "@/lib/admin-audit";
import type { AdminJob } from "@/types";

/**
 * User deletion as a resumable job (admin panel §4.2). A doc at
 * adminJobs/{jobId} tracks which of the four ordered stages
 * (export -> blob -> firestore -> auth) have completed, so re-POSTing the
 * same job after a timeout resumes rather than restarts. Order matters: Auth
 * is deleted last so a mid-way failure still leaves an account you can
 * identify and retry.
 */

const jobsCollection = () => adminDb().collection("adminJobs");

export async function createDeleteJob(targetUid: string, exportFirst: boolean): Promise<string> {
  const now = new Date().toISOString();
  const job: Omit<AdminJob, "id"> = {
    kind: "user.delete",
    targetUid,
    exportFirst,
    status: "queued",
    deletedCollections: [],
    createdAt: now,
    updatedAt: now
  };
  const ref = await jobsCollection().add(job);
  return ref.id;
}

export async function getDeleteJob(jobId: string): Promise<AdminJob | null> {
  const snapshot = await jobsCollection().doc(jobId).get();
  if (!snapshot.exists) return null;
  return { id: snapshot.id, ...snapshot.data() } as AdminJob;
}

async function collectCollectionDocs(collectionRef: FirebaseFirestore.CollectionReference, depth: number): Promise<unknown[]> {
  const snapshot = await collectionRef.get();
  return Promise.all(
    snapshot.docs.map(async (doc) => ({ id: doc.id, ...doc.data(), _subcollections: await collectSubcollections(doc.ref, depth) }))
  );
}

async function collectSubcollections(docRef: FirebaseFirestore.DocumentReference, depth: number): Promise<Record<string, unknown>> {
  if (depth <= 0) return {};
  const subcollections = await docRef.listCollections();
  const entries = await Promise.all(
    subcollections.map(async (col) => [col.id, await collectCollectionDocs(col, depth - 1)] as const)
  );
  return Object.fromEntries(entries);
}

async function buildUserExport(uid: string): Promise<Record<string, unknown>> {
  const userRef = adminDb().collection("users").doc(uid);
  const userDoc = await userRef.get();
  const subcollections = await collectSubcollections(userRef, 3);
  return { uid, exportedAt: new Date().toISOString(), profile: userDoc.exists ? userDoc.data() : null, data: subcollections };
}

async function runExportStage(job: AdminJob): Promise<Partial<AdminJob>> {
  if (!job.exportFirst || job.exportUrl) return {};
  // Blob is optional infra (same as PDF upload, lib/files.ts) — a missing token
  // must never block a deletion the admin explicitly confirmed, only skip the
  // export step. exportUrl stays unset so the UI can say so plainly.
  if (!process.env.BLOB_READ_WRITE_TOKEN) return {};
  const data = await buildUserExport(job.targetUid);
  const blob = await put(`exports/${job.targetUid}-${Date.now()}.json`, JSON.stringify(data, null, 2), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false
  });
  return { exportUrl: blob.url };
}

async function runBlobStage(job: AdminJob): Promise<Partial<AdminJob>> {
  if (job.deletedCollections.includes("blob")) return {};
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { deletedCollections: [...job.deletedCollections, "blob"] };
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: `u/${job.targetUid}/`, cursor, limit: 200 });
    if (page.blobs.length > 0) await del(page.blobs.map((b) => b.url));
    cursor = page.cursor;
  } while (cursor);
  return { deletedCollections: [...job.deletedCollections, "blob"] };
}

async function runFirestoreStage(job: AdminJob): Promise<Partial<AdminJob>> {
  if (job.deletedCollections.includes("firestore")) return {};
  await adminDb().recursiveDelete(adminDb().collection("users").doc(job.targetUid));
  return { deletedCollections: [...job.deletedCollections, "firestore"] };
}

async function runAuthStage(job: AdminJob): Promise<Partial<AdminJob>> {
  if (job.deletedCollections.includes("auth")) return {};
  try {
    await adminAuth().deleteUser(job.targetUid);
  } catch (error) {
    // Already deleted (e.g. a retried job) is not a failure.
    if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
  }
  return { deletedCollections: [...job.deletedCollections, "auth"] };
}

/** Advances a job by one call — runs whichever stages aren't done yet. Safe to re-POST after a timeout. */
export async function advanceDeleteJob(jobId: string, actor: { uid: string; email: string }): Promise<AdminJob> {
  const ref = jobsCollection().doc(jobId);
  let job = await getDeleteJob(jobId);
  if (!job) throw new Error(`No job with id ${jobId}.`);

  const targetAuthUser = await adminAuth().getUser(job.targetUid).catch(() => null);
  if (targetAuthUser?.customClaims?.role === "owner") {
    throw new Error("The owner account cannot be deleted.");
  }

  await ref.set({ status: "running", updatedAt: new Date().toISOString() }, { merge: true });

  try {
    for (const stage of [runExportStage, runBlobStage, runFirestoreStage, runAuthStage]) {
      const patch = await stage(job);
      if (Object.keys(patch).length > 0) {
        await ref.set({ ...patch, updatedAt: new Date().toISOString() }, { merge: true });
        job = { ...job, ...patch } as AdminJob;
      }
    }
    await ref.set({ status: "done", updatedAt: new Date().toISOString() }, { merge: true });
    await writeAuditEntry({
      actorUid: actor.uid,
      actorEmail: actor.email,
      action: "user.delete",
      targetType: "user",
      targetId: job.targetUid,
      after: { exportUrl: job.exportUrl }
    });
  } catch (error) {
    await ref.set({ status: "failed", error: error instanceof Error ? error.message : "unknown error", updatedAt: new Date().toISOString() }, { merge: true });
    throw error;
  }

  return (await getDeleteJob(jobId))!;
}
