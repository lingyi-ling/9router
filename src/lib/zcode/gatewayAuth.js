// Shared API-key gate for the ZCode official-gateway endpoints (plugin-MCP
// relay + off-peak async channel). Mirrors the /v1 LLM routes: enforced only
// when `settings.requireApiKey` is on (local mode is open).
import { getSettings } from "@/lib/localDb";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth.js";

function jsonError(status, type, message) {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * @returns {Response|null} an error response to short-circuit, or null when OK.
 */
export async function authorizeGatewayRequest(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;
  const apiKey = extractApiKey(request);
  if (!apiKey) return jsonError(401, "unauthorized", "Missing API key");
  if (!(await isValidApiKey(apiKey))) return jsonError(401, "unauthorized", "Invalid API key");
  return null;
}