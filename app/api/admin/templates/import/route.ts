import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { importFromOwnDayTemplate, TemplateValidationError } from "@/lib/admin-templates";

export async function POST(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as { dayTemplateId?: string } | null;
  if (!body?.dayTemplateId) return NextResponse.json({ error: "dayTemplateId is required." }, { status: 400 });

  try {
    const id = await importFromOwnDayTemplate(auth, body.dayTemplateId);
    return NextResponse.json({ id });
  } catch (error) {
    if (error instanceof TemplateValidationError) return NextResponse.json({ error: error.message, details: error.errors }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to import template." }, { status: 400 });
  }
}
