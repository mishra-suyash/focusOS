import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { getAdminTemplate, TemplateValidationError, updateTemplate } from "@/lib/admin-templates";
import type { OrgTemplate } from "@/lib/templates/schema";

export async function GET(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { templateId } = await params;
  const template = await getAdminTemplate(templateId);
  if (!template) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ template });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { templateId } = await params;
  const patch = (await request.json().catch(() => null)) as Partial<
    Pick<OrgTemplate, "name" | "description" | "payload" | "packIds" | "audienceTierIds">
  > | null;
  if (!patch) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  try {
    await updateTemplate(auth, templateId, patch);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TemplateValidationError) return NextResponse.json({ error: error.message, details: error.errors }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update template." }, { status: 400 });
  }
}
