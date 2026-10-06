import { NextResponse } from "next/server";
import { claimSchedulerStatus, startClaimScheduler, stopClaimScheduler } from "@/lib/zcode/claimService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/zcode/claim/scheduler — report the auto-claim scheduler status.
 * POST /api/zcode/claim/scheduler — { action: "start" | "stop" }.
 * Dashboard-protected (deny-by-default /api/* auth). v0.7.0
 */
export async function GET() {
  return NextResponse.json({ status: claimSchedulerStatus() });
}

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const action = body?.action;
  if (action === "start") return NextResponse.json(startClaimScheduler());
  if (action === "stop") return NextResponse.json(stopClaimScheduler());
  return NextResponse.json({ error: "action must be 'start' or 'stop'" }, { status: 400 });
}