import { NextResponse } from "next/server";
import {
  opAllAccountsSummary,
  opCheckin,
  opActivity,
  opTravel,
  opKeepalive,
  opCompleteTasks,
  opCompleteTasksAll,
  startCodeBuddyRewardsScheduler,
  stopCodeBuddyRewardsScheduler,
  codeBuddyRewardsSchedulerStatus,
} from "@/lib/codebuddy/rewardsService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/codebuddy/rewards — 账号总览 + 调度状态。
 * 仪表盘受保护（/api/* 默认鉴权）。v0.8.0
 */
export async function GET() {
  const [summary, scheduler] = await Promise.all([
    opAllAccountsSummary().catch((err) => ({ accounts: [], error: err?.message || String(err) })),
    Promise.resolve(codeBuddyRewardsSchedulerStatus()),
  ]);
  return NextResponse.json({ ...summary, scheduler });
}

/**
 * POST /api/codebuddy/rewards — { action, connectionId?, only? }
 * action: checkin | activity | travel | keepalive | complete-tasks | complete-all |
 *         scheduler-start | scheduler-stop
 * v0.8.0
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch { /* allow empty */ }
  const action = body?.action;

  try {
    switch (action) {
      case "checkin": return NextResponse.json(await opCheckin());
      case "activity": return NextResponse.json(await opActivity());
      case "travel": return NextResponse.json(await opTravel());
      case "keepalive": return NextResponse.json(await opKeepalive());
      case "complete-tasks": return NextResponse.json(await opCompleteTasks(body?.connectionId, { only: body?.only }));
      case "complete-all": return NextResponse.json(await opCompleteTasksAll());
      case "scheduler-start": return NextResponse.json(startCodeBuddyRewardsScheduler());
      case "scheduler-stop": return NextResponse.json(stopCodeBuddyRewardsScheduler());
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 502 });
  }
}