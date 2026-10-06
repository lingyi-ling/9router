import { NextResponse } from "next/server";
import { opListTasks } from "@/lib/codebuddy/rewardsService.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/codebuddy/rewards/tasks?connectionId= — 单账号成长任务列表 + 可自动化标记。
 * 仪表盘受保护（/api/* 默认鉴权）。v0.8.0
 */
export async function GET(request) {
  const connectionId = new URL(request.url).searchParams.get("connectionId") || undefined;
  const result = await opListTasks(connectionId);
  return NextResponse.json(result, { status: result.error ? 404 : 200 });
}