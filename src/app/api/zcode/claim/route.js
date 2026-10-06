import { NextResponse } from "next/server";
import { claimNow } from "@/lib/zcode/claimService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/zcode/claim — claim a plan immediately (body: { plan_id? }).
 * Dashboard-protected (deny-by-default /api/* auth). v0.7.0
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const outcome = await claimNow(body?.plan_id || body?.planId);
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 409 });
}