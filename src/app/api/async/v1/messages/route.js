import { handleAsyncMessages } from "open-sse/offpeak/handler.js";
import { resolveZcodeCredential } from "@/lib/zcode/credentials.js";
import { authorizeGatewayRequest } from "@/lib/zcode/gatewayAuth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /async/v1/messages — Anthropic Messages over the off-peak async channel.
 * v0.7.0 移植自 zcode-api POST /async/v1/messages。
 */
export async function POST(request) {
  const denied = await authorizeGatewayRequest(request);
  if (denied) return denied;
  const credential = await resolveZcodeCredential();
  return handleAsyncMessages(request, { credentials: credential });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}