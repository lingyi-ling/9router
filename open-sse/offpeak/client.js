// Off-peak (闲时通道) ticket-queue HTTP client — ported from zcode-api
// src/async/client.ts (ZCode's off-peak control plane).
//
// Implements the 4 control-plane endpoints:
//   GET  /ticket/availability        — probe queue availability
//   POST /ticket                     — take a number (queue entry)
//   POST /ticket/status              — batch poll ticket states
//   POST /ticket/{id}/settle         — close-out (success/abort/cancel)
//
// Each method has its own short timeout (default 15s). 4xx on `settle` resolves
// as success (the server already cleaned up). Other 4xx/5xx throw
// OffPeakServerError. Canonical envelope `{code:0,data}` is unwrapped; a
// non-zero numeric `code` on HTTP 200 is a business error.
//
// v0.7.0 移植：作为 9router 的闲时通道子系统，与 P1/P2 同源。
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;
const MAX_BATCH_STATUS = 100;

export class OffPeakServerError extends Error {
  constructor(message, httpStatus, bizCode) {
    super(message);
    this.name = "OffPeakServerError";
    this.httpStatus = httpStatus;
    this.bizCode = bizCode;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.origin - off-peak backend origin
 * @param {{jwt:string, codingPlanApiKey:string, bigmodelOrganization?:string, bigmodelProject?:string}} opts.credentials
 * @param {number} [opts.controlTimeoutMs]
 * @param {number} [opts.settleTimeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createOffPeakClient(opts) {
  const origin = String(opts.origin || "").replace(/\/+$/, "");
  const credentials = opts.credentials || {};
  const controlTimeoutMs = opts.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const settleTimeoutMs = opts.settleTimeoutMs ?? controlTimeoutMs;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  function buildHeaders(hasBody) {
    const h = {
      authorization: `Bearer ${credentials.jwt}`,
      "x-coding-plan-api-key": credentials.codingPlanApiKey,
    };
    if (hasBody) h["content-type"] = "application/json";
    if (credentials.bigmodelOrganization) h["bigmodel-organization"] = credentials.bigmodelOrganization;
    if (credentials.bigmodelProject) h["bigmodel-project"] = credentials.bigmodelProject;
    return h;
  }

  async function request(method, path, body, timeoutMs, externalSignal, isSettle, settleAsSuccess) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const url = `${origin}/api/v1/off-peak${path}`;
    const init = { method, headers: buildHeaders(body !== undefined), signal: controller.signal };
    if (body !== undefined) init.body = JSON.stringify(body);

    // Single outer try/finally covers BOTH fetch + body consumption so the timer
    // and abort listener are released on every path.
    let resp;
    let raw = "";
    try {
      try {
        resp = await fetchImpl(url, init);
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (/abort/i.test(msg)) throw new OffPeakServerError(`off-peak request aborted: ${method} ${path}`, 0);
        throw new OffPeakServerError(`off-peak network error: ${method} ${path}: ${msg}`, 0);
      }
      raw = await resp.text();
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    if (!resp.ok) {
      // Settle-specific: 4xx means the server already cleaned up — treat as success.
      if (isSettle && settleAsSuccess && resp.status >= 400 && resp.status < 500) return undefined;
      let bizCode;
      let serverMsg = `HTTP ${resp.status}`;
      try {
        const parsed = JSON.parse(raw);
        bizCode = parsed?.code !== undefined ? String(parsed.code) : undefined;
        if (parsed?.msg) serverMsg = String(parsed.msg);
        else if (parsed?.message) serverMsg = String(parsed.message);
      } catch {
        if (raw.length > 0 && raw.length < 200) serverMsg = raw;
      }
      throw new OffPeakServerError(`off-peak ${method} ${path} failed: ${serverMsg}`, resp.status, bizCode);
    }

    if (raw.length === 0) return undefined;
    let parsedJson;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return undefined;
    }
    // Unwrap canonical envelope `{code:0, data}`. Only numeric code === 0 counts
    // as success; a present-but-non-zero code is a business error.
    if (parsedJson && typeof parsedJson === "object") {
      if ("code" in parsedJson || "data" in parsedJson) {
        const code = parsedJson.code;
        if (code !== 0) {
          if (code !== undefined) {
            const msg = parsedJson.msg ?? parsedJson.message ?? `biz code ${String(code)}`;
            throw new OffPeakServerError(`off-peak ${method} ${path} biz error: ${msg}`, resp?.status ?? 0, String(code));
          }
        } else if (parsedJson.data !== undefined) {
          return parsedJson.data;
        }
      }
    }
    return parsedJson;
  }

  return {
    async getAvailability(signal) {
      const data = await request("GET", "/ticket/availability", undefined, controlTimeoutMs, signal, false, false);
      if (!data) throw new OffPeakServerError("off-peak availability empty response", 0);
      const result = { canTakeNumber: data.can_take_number === true };
      if (!result.canTakeNumber && data.next_take_at === undefined) {
        throw new OffPeakServerError("off-peak availability missing next_take_at while unavailable", 0);
      }
      if (data.next_take_at !== undefined) result.nextTakeAt = data.next_take_at;
      return result;
    },

    async takeTicket(taskId, signal) {
      if (!taskId || typeof taskId !== "string") throw new Error("takeTicket: taskId must be a non-empty string");
      const data = await request("POST", "/ticket", { task_id: taskId }, controlTimeoutMs, signal, false, false);
      if (!data || typeof data.ticket_id !== "string" || typeof data.state !== "string") {
        throw new OffPeakServerError("off-peak takeTicket malformed response", 0);
      }
      const result = { ticketId: data.ticket_id, state: data.state, registeredAt: Date.now() };
      if (data.position != null) result.position = data.position;
      if (data.next_poll_after !== undefined) result.nextPollAfterMs = data.next_poll_after * 1000;
      return result;
    },

    async batchStatus(ticketIds, signal) {
      if (ticketIds.length === 0) return { tickets: [] };
      const truncated = ticketIds.slice(0, MAX_BATCH_STATUS);
      const data = await request("POST", "/ticket/status", { ticket_ids: truncated }, controlTimeoutMs, signal, false, false);
      if (!data || !Array.isArray(data.tickets)) {
        throw new OffPeakServerError("off-peak batchStatus malformed response", 0);
      }
      const result = {
        tickets: data.tickets.map((t) => {
          if (typeof t.ticket_id !== "string" || typeof t.state !== "string") {
            throw new OffPeakServerError("off-peak batchStatus ticket entry malformed", 0);
          }
          const item = { ticketId: t.ticket_id, state: t.state };
          if (t.position != null) item.position = t.position;
          if (t.active_deadline !== undefined) item.activeDeadline = t.active_deadline;
          return item;
        }),
      };
      if (data.next_poll_after !== undefined) result.nextPollAfterMs = data.next_poll_after * 1000;
      return result;
    },

    async settle(ticketId, settleOpts = {}) {
      const settleAsSuccess = settleOpts.settleAsSuccess !== false;
      await request(
        "POST",
        `/ticket/${encodeURIComponent(ticketId)}/settle`,
        undefined,
        settleTimeoutMs,
        settleOpts.signal,
        true,
        settleAsSuccess,
      );
    },
  };
}

/** Non-terminal ticket states — ticket may still become ready. */
export const TICKET_PENDING_STATES = ["queued"];
/** Terminal ticket states — no further transitions. */
export const TICKET_TERMINAL_STATES = ["settled", "expired", "not_found"];

export function isTicketReady(state) {
  return state === "ready" || state === "active";
}

export function isTicketExpired(state) {
  return state === "expired" || state === "not_found";
}

/** Detect the upstream "off-peak-ticket-expired" signal in an error message. */
export function isOffPeakTicketExpiredError(e) {
  if (e == null) return false;
  if (typeof e === "string") return e.includes("off-peak-ticket-expired");
  if (e instanceof Error) return e.message.includes("off-peak-ticket-expired");
  return false;
}