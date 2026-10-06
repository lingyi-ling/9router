// Off-peak (闲时通道) route handlers — ported from zcode-api src/async/handler.ts.
//
// Three handlers:
//   - handleAsyncMessages  (Anthropic client, POST /async/v1/messages)       — passthrough
//   - handleAsyncChat      (OpenAI client, POST /async/v1/chat/completions)  — OpenAI→Anthropic request, Anthropic SSE→OpenAI SSE response
//   - handleAsyncHealth    (GET  /async/v1/health)                           — probe queue availability
//
// Pre-flight order (validate BEFORE takeTicket, so a bad request never leaks a
// ticket): credential → parse/validate body → build upstream Anthropic body →
// takeTicket.
//
// v0.7.0 移植：翻译复用 9router 的 translator 注册表（translateRequest /
// translateResponse），身份头由 offpeak/identity.js 提供。
import { FORMATS } from "../translator/formats.js";
import { translateRequest } from "../translator/index.js";
import { applyGlmBodyAlignment } from "../utils/glmBodyAlign.js";
import { createOffPeakClient } from "./client.js";
import { runAsyncBridge } from "./bridge.js";
import { anthropicSseToOpenaiSseWithKeepalive } from "./openaiStreamAdapter.js";
import { nonStreamChunkedJson } from "./aggregate.js";
import { resolveOffPeakConfig, MAX_REQUEST_BODY_BYTES } from "./config.js";

function jsonError(status, type, message) {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };
}

function generateTaskId() {
  return `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveModel(reqModel, cfg) {
  const explicit = typeof reqModel === "string" ? reqModel.trim() : "";
  return explicit || cfg.defaultModel;
}

/** Map the shared credential shape ({jwt, planKey}) to off-peak credentials. */
function toOffPeakCredentials(cred) {
  if (!cred?.jwt) return null;
  return { jwt: cred.jwt, codingPlanApiKey: cred.planKey || "" };
}

async function readBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const cl = parseInt(contentLength, 10);
    if (Number.isFinite(cl) && cl > MAX_REQUEST_BODY_BYTES) {
      request.body?.cancel().catch(() => {});
      return { ok: false, response: jsonError(413, "request_too_large", `body exceeds ${MAX_REQUEST_BODY_BYTES} byte cap`) };
    }
  }
  if (!request.body) {
    return { ok: false, response: jsonError(400, "invalid_request_error", "missing request body") };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: jsonError(413, "request_too_large", `body exceeds ${MAX_REQUEST_BODY_BYTES} byte cap`) };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: jsonError(400, "invalid_request_error", "could not read request body") };
  } finally {
    reader.releaseLock?.();
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks));
  if (!body || body.length === 0) {
    return { ok: false, response: jsonError(400, "invalid_request_error", "empty request body") };
  }
  return { ok: true, body };
}

/** Align an outbound Anthropic body with the official client (cache_control / metadata). */
function alignAnthropicBody(bodyObj) {
  const cloned = JSON.parse(JSON.stringify(bodyObj));
  applyGlmBodyAlignment("glm", cloned, "claude", {
    providerSpecificData: { deviceMid: process.env.ZCODE_IDENTITY_DEVICE_MID },
  });
  return JSON.stringify(cloned);
}

function buildBridge(cfg, client, credentials, llmRequestBody, initialTicket, taskId, request) {
  return runAsyncBridge({
    client,
    credentials,
    origin: cfg.origin,
    llmRequestBody,
    initialTicket,
    taskId,
    pollIntervalMs: cfg.pollIntervalMs,
    keepAliveIntervalMs: cfg.keepAliveIntervalMs,
    maxRetries: cfg.maxRetries,
    maxWaitMs: cfg.maxWaitMs,
    clientSignal: request.signal,
  });
}

function buildClient(cfg, credentials) {
  return createOffPeakClient({
    origin: cfg.origin,
    credentials,
    controlTimeoutMs: cfg.controlTimeoutMs,
    settleTimeoutMs: cfg.settleTimeoutMs,
  });
}

async function preflight(request, opts) {
  const cfg = opts.config || resolveOffPeakConfig();
  if (!cfg.enabled) return { error: jsonError(404, "async_disabled", "off-peak async channel is disabled") };
  const credentials = toOffPeakCredentials(opts.credentials);
  if (!credentials) {
    return {
      error: jsonError(
        400,
        "async_credentials_unavailable",
        "async endpoints require a logged-in OAuth credential (JWT missing). Log in with glm / glm-cn, or use the sync /v1/* endpoints.",
      ),
    };
  }
  return { cfg, credentials };
}

export async function handleAsyncMessages(request, opts) {
  const pre = await preflight(request, opts);
  if (pre.error) return pre.error;
  const { cfg, credentials } = pre;

  const bodyResult = await readBody(request);
  if (!bodyResult.ok) return bodyResult.response;

  let parsedBody;
  try {
    const raw = JSON.parse(bodyResult.body);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return jsonError(400, "invalid_request_error", "request body must be a JSON object");
    }
    parsedBody = raw;
  } catch {
    return jsonError(400, "invalid_request_error", "request body is not valid JSON");
  }
  if (!Array.isArray(parsedBody.messages) || parsedBody.messages.length === 0) {
    return jsonError(400, "invalid_request_error", "missing or invalid `messages` field");
  }
  const clientWantsStream = parsedBody.stream === true;

  const upstreamBody = { ...parsedBody, model: resolveModel(parsedBody.model, cfg), stream: true };
  const upstreamBodyText = alignAnthropicBody(upstreamBody);

  const client = buildClient(cfg, credentials);
  const taskId = generateTaskId();
  let ticket;
  try {
    ticket = await client.takeTicket(taskId, request.signal);
  } catch (err) {
    return jsonError(502, "async_take_ticket_failed", `off-peak takeTicket failed: ${err?.message}`);
  }

  const { stream } = buildBridge(cfg, client, credentials, upstreamBodyText, ticket, taskId, request);
  if (clientWantsStream) return new Response(stream, { status: 200, headers: sseHeaders() });
  return new Response(nonStreamChunkedJson(stream), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}

export async function handleAsyncChat(request, opts) {
  const pre = await preflight(request, opts);
  if (pre.error) return pre.error;
  const { cfg, credentials } = pre;

  const bodyResult = await readBody(request);
  if (!bodyResult.ok) return bodyResult.response;

  let openaiReq;
  try {
    openaiReq = JSON.parse(bodyResult.body);
  } catch {
    return jsonError(400, "invalid_request_error", "request body is not valid JSON");
  }
  if (!Array.isArray(openaiReq.messages) || openaiReq.messages.length === 0) {
    return jsonError(400, "invalid_request_error", "missing or invalid `messages` field");
  }
  openaiReq.model = resolveModel(openaiReq.model, cfg);
  const clientWantsStream = openaiReq.stream === true;

  let anthropicReq;
  try {
    anthropicReq = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, openaiReq.model, openaiReq, true, null, null);
  } catch (err) {
    return jsonError(400, "invalid_request_error", `OpenAI→Anthropic translation failed: ${err?.message}`);
  }
  // Strip translator bookkeeping before forwarding.
  delete anthropicReq._toolNameMap;
  delete anthropicReq._customToolNames;
  anthropicReq.stream = true;
  const upstreamBodyText = alignAnthropicBody(anthropicReq);

  const client = buildClient(cfg, credentials);
  const taskId = generateTaskId();
  let ticket;
  try {
    ticket = await client.takeTicket(taskId, request.signal);
  } catch (err) {
    return jsonError(502, "async_take_ticket_failed", `off-peak takeTicket failed: ${err?.message}`);
  }

  const { stream: rawStream } = buildBridge(cfg, client, credentials, upstreamBodyText, ticket, taskId, request);
  if (clientWantsStream) {
    const openaiStream = anthropicSseToOpenaiSseWithKeepalive(rawStream, openaiReq.model);
    return new Response(openaiStream, { status: 200, headers: sseHeaders() });
  }
  const openaiStream = anthropicSseToOpenaiSseWithKeepalive(rawStream, openaiReq.model);
  return new Response(nonStreamChunkedJson(openaiStream, { translate: "openai", model: openaiReq.model }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}

export async function handleAsyncHealth(_request, opts) {
  const pre = await preflight(_request, opts);
  if (pre.error) return pre.error;
  const { cfg, credentials } = pre;
  const client = buildClient(cfg, credentials);
  try {
    const avail = await client.getAvailability();
    return Response.json(avail);
  } catch (err) {
    return jsonError(502, "async_health_failed", err?.message || String(err));
  }
}