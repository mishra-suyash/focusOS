"use client";

import { upload } from "@vercel/blob/client";
import type { User } from "firebase/auth";
import { adjustBlobUsage, createFileRef, deleteFileRef } from "@/lib/firestore";
import { validatePdfFile } from "@/lib/files";
import type { FileRef } from "@/types";

/** Uploads a PDF directly from the browser to Vercel Blob — the bytes never pass through a Next.js function. Throws with a user-facing message on failure (including the expected "not configured" case). */
export async function uploadPaperPdf(user: User, file: File, paperId: string): Promise<FileRef & { id: string }> {
  const validation = validatePdfFile(file);
  if (!validation.ok) throw new Error(validation.error);

  const token = await user.getIdToken();
  const pathname = `u/${user.uid}/paper/${crypto.randomUUID()}.pdf`;

  const blob = await upload(pathname, file, {
    access: "public",
    handleUploadUrl: "/api/files/upload-token",
    headers: { Authorization: `Bearer ${token}` },
    contentType: "application/pdf"
  });

  const fileRef: Omit<FileRef, "id"> = {
    url: blob.url,
    pathname: blob.pathname,
    bytes: file.size,
    contentType: "application/pdf",
    linkedTo: { type: "paper", id: paperId },
    uploadedAt: new Date().toISOString()
  };
  const id = await createFileRef(user.uid, fileRef);
  await adjustBlobUsage(user.uid, file.size);
  return { id, ...fileRef };
}

/** Deletes the blob (server-side, needs the write token) and the local Firestore doc + usage counter. */
export async function deletePaperPdf(user: User, fileId: string, bytes: number) {
  const token = await user.getIdToken();
  const response = await fetch(`/api/files/${fileId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete file.");
  }
  await deleteFileRef(user.uid, fileId);
  await adjustBlobUsage(user.uid, -bytes);
}
