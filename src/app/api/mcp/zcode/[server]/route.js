import {
  lookupZcodeMcpServer,
  resolveZcodeMcpUpstreamOrigin,
  resolveZcodeMcpUpstreamPath,
} from "@/lib/mcp/zcodeOfficialCatalogue.js";
import {
  authorizeMcpRequest,
  resolveZcodeMcpCredential,
  buildZcodeMcpAuthHeaders,
  relayZcodeMcpRequest,
  jsonError,
} from "@/lib/mcp/zcodeRelay.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streamable-HTTP MCP uses POST (JSON-RPC), GET (SSE stream) and DELETE (close).
export async function POST(request, { params }) {
  return relay(request, params);
}
export async function GET(request, { params }) {
  return relay(request, params);
}
export async function DELETE(request, { params }) {
  return relay(request, params);
}

/**
 * Any of POST/GET/DELETE /mcp/{server} — relay to the official ZCode gateway.
 * v0.7.0 移植自 zcode-api handleMcpRelayRoute。
 */
async function relay(request, params) {
  const denied = await authorizeMcpRequest(request);
  if (denied) return denied;

  const { server } = await params;
  const def = lookupZcodeMcpServer(server);
  if (!def) {
    return jsonError(
      404,
      "mcp_server_not_found",
      `Unknown MCP server "${server}" — see GET /mcp for the served endpoints`,
    );
  }

  let credential;
  try {
    credential = await resolveZcodeMcpCredential();
  } catch (err) {
    return jsonError(400, "mcp_credentials_unavailable", err?.message || String(err));
  }
  if (!credential) {
    return jsonError(
      400,
      "mcp_credentials_unavailable",
      "no ZCode credential with a JWT — log in with OAuth (glm / glm-cn) to use the /mcp relay",
    );
  }

  const authHeaders = buildZcodeMcpAuthHeaders(credential);
  const incoming = new URL(request.url);
  const upstreamUrl =
    `${resolveZcodeMcpUpstreamOrigin()}${resolveZcodeMcpUpstreamPath(def)}${incoming.search}`;
  return relayZcodeMcpRequest(request, authHeaders, upstreamUrl);
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