import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { getAdminSettings, updateAdminSettings } from "@/lib/admin-settings";
import type { AdminSettings } from "@/types";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;
  return NextResponse.json(await getAdminSettings());
}

export async function PUT(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const patch = (await request.json().catch(() => null)) as Partial<AdminSettings> | null;
  if (!patch) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  const updated = await updateAdminSettings(patch, auth);
  return NextResponse.json(updated);
}
