import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { advanceDeleteJob, getDeleteJob } from "@/lib/admin-user-delete";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { jobId } = await params;
  const job = await getDeleteJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ job });
}

/** Resumes a job stuck at "running"/"failed" — safe to call repeatedly, each stage is idempotent. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { jobId } = await params;
  try {
    const job = await advanceDeleteJob(jobId, auth);
    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to resume job." }, { status: 500 });
  }
}
