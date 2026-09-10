import { del } from "@vercel/blob";
import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";

/**
 * Deletes a file's blob and its Firestore metadata doc. Server-side because
 * Blob deletion needs the read-write token, which the client never holds.
 * The `usage/blobUsage` byte decrement happens client-side after this
 * succeeds (see lib/files-client.ts) — this route only removes the file.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: "Missing Authorization header." }, { status: 401 });

  let uid: string;
  try {
    const decoded = await adminAuth().verifyIdToken(token);
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: "Invalid or expired token." }, { status: 401 });
  }

  const fileDoc = await adminDb().collection("users").doc(uid).collection("files").doc(id).get();
  if (!fileDoc.exists) {
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  }

  const data = fileDoc.data() as { url: string; bytes: number };
  try {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      await del(data.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
    }
    await fileDoc.ref.delete();
    return NextResponse.json({ ok: true, bytes: data.bytes });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete file." }, { status: 500 });
  }
}
