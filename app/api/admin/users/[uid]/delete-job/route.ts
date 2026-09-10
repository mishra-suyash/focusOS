import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { adminAuth } from "@/lib/firebase-admin";
import { advanceDeleteJob, createDeleteJob } from "@/lib/admin-user-delete";

/**
 * Creates the job and immediately runs its first advance in the same request
 * — most deletions (a handful of subcollections, no PDFs) finish well inside
 * this route's 300s budget (vercel.json). If it doesn't, the job doc records
 * how far it got and GET /api/admin/jobs/:jobId lets the client re-POST here
 * to resume, per admin panel §4.2.
 */
export async function POST(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { uid } = await params;

  // Checked before a job doc is even created, so a rejected attempt at deleting
  // the owner doesn't litter adminJobs with a permanently-failed entry.
  const targetUser = await adminAuth().getUser(uid).catch(() => null);
  if (targetUser?.customClaims?.role === "owner") {
    return NextResponse.json({ error: "The owner account cannot be deleted." }, { status: 409 });
  }

  const body = (await request.json().catch(() => ({}))) as { exportFirst?: boolean };
  const jobId = await createDeleteJob(uid, body.exportFirst !== false);

  try {
    const job = await advanceDeleteJob(jobId, auth);
    return NextResponse.json({ jobId, job });
  } catch (error) {
    return NextResponse.json({ jobId, error: error instanceof Error ? error.message : "Deletion job failed." }, { status: 500 });
  }
}
