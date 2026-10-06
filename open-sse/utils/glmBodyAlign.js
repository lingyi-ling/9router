// GLM (Z.ai / Bigmodel) coding-plan request-body alignment — mirrors the
// official ZCode desktop client so requests are indistinguishable upstream.
// Ported from zcode-api src/proxy/body-transformer.ts (the non-start-plan
// parts; start-plan gateway injection is intentionally NOT ported — 9router
// has no plan-tier credential, see docs note in the PR).
//
// Applied to outbound GLM-family requests only:
//   1. OpenAI + stream → `stream_options.include_usage: true`
//   2. Anthropic/Claude → clear stale `cache_control` on non-system messages,
//      then mark the last non-system message's last block `{type:"ephemeral"}`
//   3. Anthropic/Claude → inject `metadata.user_id` when the connection carries
//      a device/session id (v0.7.0)
//
// 所有变换在解析失败/结构不符时都是 no-op —— 只是少一个优化，绝不破坏请求。
const GLM_PROVIDERS = new Set(["glm", "glm-cn"]);

/**
 * Mutate a GLM-family outbound body in place (best-effort).
 * @param {string} provider - provider id (glm / glm-cn)
 * @param {object} body - outbound request body
 * @param {string} format - runtime wire format ("openai" | "claude"/"anthropic")
 * @param {object} credentials - connection credentials
 */
export function applyGlmBodyAlignment(provider, body, format, credentials) {
  if (!GLM_PROVIDERS.has(provider)) return;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;

  if (isAnthropic(format)) {
    applyAnthropicCacheControl(body);
    const userId = buildMetadataUserId(credentials?.providerSpecificData);
    if (userId) applyAnthropicUserId(body, userId);
  } else if (format === "openai") {
    applyStreamOptionsIncludeUsage(body);
  }
}

function isAnthropic(format) {
  return format === "claude" || format === "anthropic";
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** OpenAI streaming: ensure `stream_options.include_usage: true`. */
function applyStreamOptionsIncludeUsage(body) {
  if (body.stream !== true) return;
  const existing = body.stream_options;
  if (isPlainObject(existing) && existing.include_usage === true) return;
  body.stream_options = { ...(isPlainObject(existing) ? existing : {}), include_usage: true };
}

/**
 * Anthropic two-phase cache_control, mirroring the ZCode bundle's clear (`zsi`)
 * + mark (`Fsi`) pair:
 *   (1) strip `cache_control` from every block of every NON-system message;
 *   (2) mark the last content block of the LAST non-system message with
 *       `{type:"ephemeral"}`; string content is converted to a block array.
 * The top-level `system` field is left untouched.
 */
function applyAnthropicCacheControl(body) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // Phase 1: clear stale markers on non-system messages.
  for (const msg of messages) {
    if (!isPlainObject(msg) || msg.role === "system") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isPlainObject(block) && "cache_control" in block) delete block.cache_control;
    }
  }

  // Phase 2: mark the last non-system message's last block.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isPlainObject(msg) || msg.role === "system") continue;

    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlock = msg.content[msg.content.length - 1];
      if (isPlainObject(lastBlock) && !lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
      }
      return;
    }
    return;
  }
}

/**
 * Anthropic: inject `metadata.user_id` when we can assemble the ZCode device /
 * session blob. 9router only has these when the connection was created through
 * the OAuth poll flow AND the client supplied a session id — otherwise the
 * injection is skipped entirely (an all-empty blob would be a distinguisher).
 * Preserves any existing `metadata.*` fields other than `user_id`.
 */
function applyAnthropicUserId(body, userId) {
  const existing = body.metadata;
  if (isPlainObject(existing) && existing.user_id === userId) return;
  body.metadata = { ...(isPlainObject(existing) ? existing : {}), user_id: userId };
}

function buildMetadataUserId(psd) {
  if (!isPlainObject(psd)) return null;
  const deviceId = typeof psd.deviceMid === "string" ? psd.deviceMid.trim() : "";
  const sessionId = typeof psd.sessionId === "string" ? psd.sessionId.trim() : "";
  if (!deviceId && !sessionId) return null;
  return JSON.stringify({ device_id: deviceId, account_uuid: "", session_id: sessionId });
}