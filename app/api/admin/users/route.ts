import { NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/api-auth";
import { listUsers } from "@/lib/admin-users";
import type { UserRole, UserStatus } from "@/types";

export async function GET(request: Request) {
  const auth = await verifyAdminRequest(request);
  if ("error" in auth) return auth.error;

  const url = new URL(request.url);
  const result = await listUsers({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: Number(url.searchParams.get("limit")) || undefined,
    role: (url.searchParams.get("role") as UserRole | null) ?? undefined,
    status: (url.searchParams.get("status") as UserStatus | null) ?? undefined,
    tierId: url.searchParams.get("tierId") ?? undefined,
    search: url.searchParams.get("search") ?? undefined
  });
  return NextResponse.json(result);
}
