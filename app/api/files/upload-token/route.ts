import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { resolveUserTier } from "@/lib/admin-tiers";
import { MAX_FILE_BYTES } from "@/lib/files";

/**
 * Vercel Blob client-upload handshake (§6 of the plan): the browser uploads
 * bytes directly to Blob storage, never through this function — this route
 * only ever sees a short JSON handshake, so the 4.5 MB Vercel function body
 * limit never applies to the PDF itself. Scoping: the client chooses a
 * pathname of the form `u/{uid}/paper/{uuid}.pdf`; this route rejects any
 * pathname that doesn't start with the authenticated caller's own uid prefix.
 */
export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "PDF uploads aren't configured (BLOB_READ_WRITE_TOKEN is not set). Add the paper as a link instead, or configure Vercel Blob." },
      { status: 501 }
    );
  }

  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const authHeader = request.headers.get("authorization");
        const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token) throw new Error("Missing Authorization header.");

        const decoded = await adminAuth().verifyIdToken(token);
        if (!pathname.startsWith(`u/${decoded.uid}/`)) {
          throw new Error("Upload path does not match the authenticated user.");
        }
        if (decoded.role === "disabled") {
          throw new Error("This account has been disabled.");
        }

        const { effectiveBlobQuotaMb } = await resolveUserTier(decoded.uid);
        const filesSnapshot = await adminDb().collection("users").doc(decoded.uid).collection("files").get();
        const usedBytes = filesSnapshot.docs.reduce((sum, doc) => sum + ((doc.data().bytes as number | undefined) ?? 0), 0);
        const quotaBytes = effectiveBlobQuotaMb * 1024 * 1024;
        if (usedBytes >= quotaBytes) {
          throw new Error(
            `Storage quota reached (${(usedBytes / (1024 * 1024)).toFixed(0)} MB of ${effectiveBlobQuotaMb} MB). Delete an existing PDF or ask an admin to raise your quota.`
          );
        }

        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: false
        };
      }
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload token generation failed." }, { status: 400 });
  }
}
