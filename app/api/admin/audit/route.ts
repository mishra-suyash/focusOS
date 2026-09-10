import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const url = new URL(request.url);
  const actorUid = url.searchParams.get("actorUid");
  const action = url.searchParams.get("action");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const cursor = url.searchParams.get("cursor");

  let query: FirebaseFirestore.Query = adminDb().collection("admin").doc("auditLog").collection("entries").orderBy("at", "desc");
  if (actorUid) query = query.where("actorUid", "==", actorUid);
  if (action) query = query.where("action", "==", action);
  if (cursor) {
    const cursorDoc = await adminDb().collection("admin").doc("auditLog").collection("entries").doc(cursor).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }

  const snapshot = await query.limit(limit).get();
  const entries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  return NextResponse.json({ entries, nextCursor: snapshot.docs.length === limit ? snapshot.docs[snapshot.docs.length - 1].id : undefined });
}
