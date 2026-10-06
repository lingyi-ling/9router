import { NextResponse } from "next/server";
import { listClaimPreviews } from "@/lib/zcode/claimService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/zcode/claim/preview — list currently claimable weekend/trial plans.
 * Dashboard-protected (deny-by-default /api/* auth). v0.7.0
 */
export async function GET() {
  const result = await listClaimPreviews();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}