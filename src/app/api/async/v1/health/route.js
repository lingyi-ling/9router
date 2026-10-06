import { handleAsyncHealth } from "open-sse/offpeak/handler.js";
import { resolveZcodeCredential } from "@/lib/zcode/credentials.js";
import { authorizeGatewayRequest } from "@/lib/zcode/gatewayAuth.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /async/v1/health — probe off-peak queue availability.
 * v0.7.0 移植自 zcode-api GET /async/v1/health。
 */
export async function GET(request) {
  const denied = await authorizeGatewayRequest(request);
  if (denied) return denied;
  const credential = await resolveZcodeCredential();
  return handleAsyncHealth(request, { credentials: credential });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}