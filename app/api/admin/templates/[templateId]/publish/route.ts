import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { publishTemplate } from "@/lib/admin-templates";

export async function POST(request: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const { templateId } = await params;
  try {
    await publishTemplate(auth, templateId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to publish template." }, { status: 400 });
  }
}
