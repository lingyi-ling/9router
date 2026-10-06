import { NextResponse } from "next/server";

import {
  scanLocalCredentials,
  localCredentialScanCapability,
} from "open-sse/codebuddy/localCredentials.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/codebuddy/credentials/scan
 *
 * 只读探测本机已登录的 CodeBuddy / WorkBuddy 凭证。
 * **不返回任何明文令牌**——只报可读性/有效性/uid/昵称/过期时间；
 * 导入需走 /api/codebuddy/credentials/import 二次确认。
 *
 * 该路由会读取本机凭证文件并拉起 WorkBuddy 客户端（原生 build key）做解密，
 * 因此已在 dashboardGuard 的 LOCAL_ONLY_PATHS 中限制为仅本机可访问。
 * [workbuddy 本机凭证 v0.8.2]
 */
export async function GET() {
  try {
    const items = scanLocalCredentials();
    return NextResponse.json({ items, ...localCredentialScanCapability() });
  } catch (error) {
    console.error("[API] CodeBuddy credential scan failed:", error);
    return NextResponse.json({ error: "Credential scan failed" }, { status: 500 });
  }
}