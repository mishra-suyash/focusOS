import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { createDraftTemplate, getTemplateSettings, listAdminTemplates, TemplateValidationError } from "@/lib/admin-templates";
import type { NewOrgTemplate } from "@/lib/templates/schema";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;
  const [templates, settings] = await Promise.all([listAdminTemplates(), getTemplateSettings()]);
  return NextResponse.json({ templates, packDefaults: settings.packDefaults, hiddenBuiltInIds: settings.hiddenBuiltInIds });
}

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as NewOrgTemplate | null;
  if (!body?.kind || !body.name || body.payload === undefined) {
    return NextResponse.json({ error: "kind, name and payload are required." }, { status: 400 });
  }

  try {
    const id = await createDraftTemplate(auth, body);
    return NextResponse.json({ id });
  } catch (error) {
    if (error instanceof TemplateValidationError) return NextResponse.json({ error: error.message, details: error.errors }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create template." }, { status: 400 });
  }
}
