import { NextResponse } from "next/server";
import { verifyActiveUser } from "@/lib/api-auth";
import { aiHealthSnapshot } from "@/lib/ai/run";

export async function GET(request: Request) {
  const auth = await verifyActiveUser(request);
  if ("error" in auth) return auth.error;

  const snapshot = await aiHealthSnapshot(auth.uid);
  return NextResponse.json(snapshot);
}
