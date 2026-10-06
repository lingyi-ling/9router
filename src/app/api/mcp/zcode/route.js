import {
  ZCODE_MCP_CATALOGUE,
  resolveZcodeMcpUpstreamOrigin,
} from "@/lib/mcp/zcodeOfficialCatalogue.js";
import { authorizeMcpRequest, resolveZcodeMcpCredential } from "@/lib/mcp/zcodeRelay.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /mcp — list the official ZCode plugin-MCP endpoints served by this
 * gateway, plus whether the current credential can use them.
 * v0.7.0 移植自 zcode-api GET /mcp。
 */
export async function GET(request) {
  const denied = await authorizeMcpRequest(request);
  if (denied) return denied;

  let credential = null;
  try {
    credential = await resolveZcodeMcpCredential();
  } catch {
    credential = null;
  }

  const servers = ZCODE_MCP_CATALOGUE.servers.map((s) => ({
    key: s.key,
    path: `/mcp/${s.key}`,
    methods: ["POST", "GET", "DELETE"],
    routeId: s.routeId,
    plugin: s.plugin,
    requiresPaidPlan: s.requiresPaidPlan,
    displayName: s.displayName,
    description: s.description,
    ...(s.category ? { category: s.category } : {}),
  }));

  return Response.json({
    object: "list",
    generatedAt: ZCODE_MCP_CATALOGUE.generatedAt,
    upstreamOrigin: resolveZcodeMcpUpstreamOrigin(),
    authReady: Boolean(credential),
    authError: credential ? null : "missing_jwt",
    servers,
  });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}