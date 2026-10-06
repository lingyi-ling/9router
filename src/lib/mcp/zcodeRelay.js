// Official ZCode plugin-MCP relay — ported from zcode-api src/mcp/relay.ts.
//
// Inbound `/mcp/{server}` → `{origin}/api/v1/mcp/server/{routeId}` with the
// stored ZCode credential injected:
//   Authorization: Bearer <zcode JWT>                        (providerSpecificData.zcodeJwtToken)
//   X-Bigmodel-Authorization: Bearer <coding-plan API key>   (accessToken / apiKey)
//   Bigmodel-Target-Type: PERSONAL
//
// The gateway rejects identity-only credentials (JSON-RPC 3101 "coding plan is
// required"), so a connection without a ZCode JWT (e.g. a pasted API key) gets
// an explicit 400 mcp_credentials_unavailable — same as the reference proxy.
//
// v0.7.0 移植：凭证取自 9router 的 glm / glm-cn OAuth 连接。
import { resolveZcodeCredential } from "@/lib/zcode/credentials.js";
import { authorizeGatewayRequest } from "@/lib/zcode/gatewayAuth.js";

// Client headers forwarded upstream. `authorization` is deliberately absent:
// the inbound gateway API key must never reach Z.ai, and our injected
// credential headers override it regardless.
const FORWARD_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

// Response headers surfaced back to the client (session binding + type).
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/**
 * Resolve a ZCode connection that carries the JWT needed by the official MCP
 * gateway (shared with the off-peak async channel).
 * @returns {{jwt:string, planKey:string, provider:string} | null}
 */
export async function resolveZcodeMcpCredential() {
  return resolveZcodeCredential();
}

/** Build the official-MCP auth headers for a resolved credential. */
export function buildZcodeMcpAuthHeaders(cred) {
  return {
    Authorization: `Bearer ${cred.jwt}`,
    "X-Bigmodel-Authorization": `Bearer ${cred.planKey}`,
    "Bigmodel-Target-Type": "PERSONAL",
  };
}

/**
 * Forward one MCP streamable-HTTP exchange (POST JSON-RPC / GET SSE stream /
 * DELETE session close) to the official gateway. The response body streams
 * through untouched so SSE works; `req.signal` ties the upstream connection to
 * the client's lifetime.
 */
export async function relayZcodeMcpRequest(req, authHeaders, upstreamUrl) {
  const headers = {};
  for (const [name, value] of req.headers) {
    if (value !== "" && FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  // Auth headers last: injected credentials win over anything a client smuggles in.
  for (const [name, value] of Object.entries(authHeaders)) headers[name] = value;

  const init = {
    method: req.method,
    headers,
    signal: req.signal,
    ...(METHODS_WITH_BODY.has(req.method) ? { body: await req.arrayBuffer() } : {}),
  };

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, init);
  } catch (err) {
    return jsonError(502, "mcp_upstream_unreachable", `official MCP gateway unreachable: ${err?.message || err}`);
  }

  const respHeaders = {};
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) respHeaders[name] = value;
  }
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

/** JSON error shaped like the reference proxy's errorResponse. */
export function jsonError(status, type, message) {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Gate the MCP endpoints with the shared gateway API-key auth.
 * @returns {Response|null} an error response to short-circuit, or null when OK.
 */
export async function authorizeMcpRequest(request) {
  return authorizeGatewayRequest(request);
}