import { NextResponse } from "next/server";
import { getAdminSettings } from "@/lib/admin-settings";

/**
 * NOT admin-gated, no auth at all — /login has to be able to read this before
 * anyone's signed in. Returns only what a login screen needs to decide which
 * buttons to render (plus maintenanceMode, folded in here rather than as a
 * separate route since both are read by the same unauthenticated page at the
 * same moment). Never exposes the rest of admin/settings.
 */
export async function GET() {
  const settings = await getAdminSettings();
  return NextResponse.json({ ...settings.signInMethods, maintenanceMode: settings.maintenanceMode });
}
