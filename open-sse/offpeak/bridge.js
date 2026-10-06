// Off-peak async bridge — ported from zcode-api src/async/bridge.ts.
//
// Core state machine turning a sync client stream expectation into the
// off-peak async reality:
//   WAIT    (queued)           → poll every pollIntervalMs; emit keepalives
//   READY   (ready/active)     → forward the LLM call with X-Off-Peak-Ticket-ID
//   EXPIRED (ticket revoked)   → settleOnce(old); retake until maxRetries
//   DONE                       → settleOnce(current); close stream
//   ABORT   (client disconnect)→ settleOnce(current); release resources
//
// Invariants: pure `: keepalive` comments only during WAIT; every ticket settles
// exactly once; retry resends the original prompt; settle is fire-and-forget.
//
// v0.7.0 移植自 zcode-api，接入 9router 的 glm / glm-cn 凭证。
import { isTicketExpired, isTicketReady } from "./client.js";
import { keepaliveFrame } from "./keepalive.js";
import { buildZcodeIdentityHeaders } from "./identity.js";

const EXPIRED_MARKER = "off-peak-ticket-expired";

/**
 * @param {object} opts
 * @param {import("./client.js").OffPeakClient} opts.client
 * @param {{jwt:string, codingPlanApiKey:string, bigmodelOrganization?:string, bigmodelProject?:string}} opts.credentials
 * @param {string} opts.origin
 * @param {string} opts.llmRequestBody
 * @param {{ticketId:string, state:string}} opts.initialTicket
 * @param {string} opts.taskId
 * @param {number} opts.pollIntervalMs
 * @param {number} opts.keepAliveIntervalMs
 * @param {number} opts.maxRetries
 * @param {number} opts.maxWaitMs
 * @param {AbortSignal} [opts.clientSignal]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(info:object)=>void} [opts.onTransition]
 * @returns {{ stream: ReadableStream<Uint8Array>, outcome: Promise<object> }}
 */
export function runAsyncBridge(opts) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const encoder = new TextEncoder();
  let outcomeResolve;
  const outcome = new Promise((r) => { outcomeResolve = r; });
  let outcomeResolved = false;
  function resolveOutcome(o) {
    if (outcomeResolved) return;
    outcomeResolved = true;
    outcomeResolve(o);
  }

  let aborted = false;
  const settledTickets = new Set();
  function settleOnce(ticketId) {
    if (settledTickets.has(ticketId)) return;
    settledTickets.add(ticketId);
    void opts.client.settle(ticketId).catch(() => { /* best-effort */ });
  }

  function log(info) {
    try { opts.onTransition?.(info); } catch { /* observability must not break the bridge */ }
  }

  function emitKeepalive(controller) {
    if (aborted) return;
    try { controller.enqueue(keepaliveFrame()); } catch { /* closed */ }
  }

  function emitTerminalError(controller, message, type = "api_error") {
    if (aborted) return;
    const payload = JSON.stringify({ type: "error", error: { type, message } });
    try { controller.enqueue(encoder.encode(`event: error\ndata: ${payload}\n\n`)); } catch { /* closed */ }
  }

  /** Wait until ready/active, expired/not_found, abort, or maxWaitMs exceeded. */
  async function waitForReady(ticketId, deadlineAt) {
    for (;;) {
      if (aborted) return { state: "expired" };
      const result = await pollBatchStatusWithRetry(ticketId);
      if (aborted) return { state: "expired" };
      const ticket = result.tickets[0];
      if (!ticket) return { state: "not_found" };
      if (isTicketReady(ticket.state)) return { state: ticket.state };
      if (ticket.state !== "queued") return { state: "expired" };

      const delay = result.nextPollAfterMs ?? opts.pollIntervalMs;
      if (opts.maxWaitMs > 0 && Date.now() + delay > deadlineAt) {
        await sleep(Math.max(0, deadlineAt - Date.now()), opts.clientSignal);
        return { state: "expired", maxWaitExceeded: true };
      }
      await sleep(delay, opts.clientSignal);
    }
  }

  /** Single batchStatus poll with local tolerance for transient control-plane errors. */
  async function pollBatchStatusWithRetry(ticketId) {
    const POLL_RETRY_LIMIT = 3;
    const retryDelayMs = Math.min(opts.pollIntervalMs, 2000);
    let lastErr;
    for (let attempt = 1; attempt <= POLL_RETRY_LIMIT; attempt++) {
      if (aborted || opts.clientSignal?.aborted) throw lastErr ?? new Error("client aborted during poll");
      try {
        return await opts.client.batchStatus([ticketId], opts.clientSignal);
      } catch (err) {
        lastErr = err;
        if (aborted || opts.clientSignal?.aborted) throw err;
        if (attempt < POLL_RETRY_LIMIT) await sleep(retryDelayMs, opts.clientSignal);
      }
    }
    throw lastErr;
  }

  async function forwardLLM(ticketId) {
    const url = `${String(opts.origin).replace(/\/+$/, "")}/api/v1/off-peak/anthropic/v1/messages`;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${opts.credentials.jwt}`,
      "x-coding-plan-api-key": opts.credentials.codingPlanApiKey,
      "x-off-peak-ticket-id": ticketId,
      ...buildZcodeIdentityHeaders(),
    };
    if (opts.credentials.bigmodelOrganization) headers["bigmodel-organization"] = opts.credentials.bigmodelOrganization;
    if (opts.credentials.bigmodelProject) headers["bigmodel-project"] = opts.credentials.bigmodelProject;

    const resp = await fetchImpl(url, {
      method: "POST",
      headers,
      body: opts.llmRequestBody,
      signal: opts.clientSignal,
    });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      return { response: new Response(bodyText, { status: resp.status, headers: resp.headers }), expiredInBody: bodyText.includes(EXPIRED_MARKER) };
    }
    return { response: resp, expiredInBody: false };
  }

  const stream = new ReadableStream({
    async start(controller) {
      if (opts.clientSignal) {
        if (opts.clientSignal.aborted) aborted = true;
        else opts.clientSignal.addEventListener("abort", () => { aborted = true; }, { once: true });
      }

      let keepAliveTimer;
      const startKeepalive = () => {
        if (keepAliveTimer) return;
        keepAliveTimer = setInterval(() => emitKeepalive(controller), opts.keepAliveIntervalMs);
      };
      const stopKeepalive = () => {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = undefined;
        }
      };

      const deadlineAt = opts.maxWaitMs > 0 ? Date.now() + opts.maxWaitMs : Number.MAX_SAFE_INTEGER;
      let currentTicket = opts.initialTicket;
      let attempt = 0;

      // Retake a fresh ticket after an expiry; emits a terminal error on failure.
      async function retake() {
        settleOnce(currentTicket.ticketId);
        attempt++;
        if (attempt > opts.maxRetries) {
          emitTerminalError(controller, `async upstream exhausted retries (ticket expired ${attempt}x)`, "api_error");
          resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
          return false;
        }
        try {
          currentTicket = await opts.client.takeTicket(opts.taskId, opts.clientSignal);
        } catch (takeErr) {
          emitTerminalError(controller, `async retake failed: ${takeErr?.message}`, "api_error");
          resolveOutcome({ attempts: attempt, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
          return false;
        }
        return true;
      }

      try {
        for (;;) {
          if (aborted) {
            log({ phase: "abort", attempt, ticketId: currentTicket.ticketId });
            settleOnce(currentTicket.ticketId);
            return;
          }

          // WAIT phase
          if (!isTicketReady(currentTicket.state)) {
            log({ phase: "wait", attempt, ticketId: currentTicket.ticketId, state: currentTicket.state });
            startKeepalive();
            const wait = await waitForReady(currentTicket.ticketId, deadlineAt);
            if (aborted) {
              stopKeepalive();
              log({ phase: "abort", attempt, ticketId: currentTicket.ticketId });
              settleOnce(currentTicket.ticketId);
              return;
            }
            if (wait.maxWaitExceeded) {
              stopKeepalive();
              settleOnce(currentTicket.ticketId);
              emitTerminalError(controller, `async max wait timeout (${opts.maxWaitMs}ms exceeded)`, "timeout");
              resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
              return;
            }
            if (isTicketExpired(wait.state)) {
              stopKeepalive();
              if (opts.maxWaitMs > 0 && Date.now() >= deadlineAt) {
                settleOnce(currentTicket.ticketId);
                emitTerminalError(controller, `async max wait timeout (${opts.maxWaitMs}ms exceeded)`, "timeout");
                resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                return;
              }
              log({ phase: "expired", attempt, ticketId: currentTicket.ticketId, state: wait.state, message: "expired in queue" });
              if (!(await retake())) return;
              continue;
            }
            stopKeepalive();
          }

          // READY phase — no keepalive (would corrupt SSE frames split across chunks)
          log({ phase: "ready", attempt, ticketId: currentTicket.ticketId });
          let resp;
          let expiredInBody;
          try {
            const forward = await forwardLLM(currentTicket.ticketId);
            resp = forward.response;
            expiredInBody = forward.expiredInBody;
          } catch (err) {
            if (aborted) {
              settleOnce(currentTicket.ticketId);
              return;
            }
            emitTerminalError(controller, `async upstream network error: ${err?.message}`, "api_error");
            settleOnce(currentTicket.ticketId);
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
            return;
          }

          if (!resp.ok || expiredInBody) {
            const bodyText = await resp.text().catch(() => "");
            if (expiredInBody || bodyText.includes(EXPIRED_MARKER)) {
              log({ phase: "expired", attempt, ticketId: currentTicket.ticketId, message: "expired during LLM (pre-stream)" });
              if (!(await retake())) return;
              continue;
            }
            emitTerminalError(controller, `async upstream HTTP ${resp.status}`, "api_error");
            settleOnce(currentTicket.ticketId);
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
            return;
          }

          // Stream upstream body with complete-frame buffering (catches the
          // expired marker even when split across network chunks).
          let midStreamExpiredPreCommit = false;
          let midStreamExpiredPostCommit = false;
          let committed = false;
          if (resp.body) {
            const reader = resp.body.getReader();
            const streamDecoder = new TextDecoder();
            let pending = "";
            const MAX_PENDING_FRAME_BYTES = 1024 * 1024;
            try {
              for (;;) {
                if (aborted) {
                  await reader.cancel().catch(() => {});
                  settleOnce(currentTicket.ticketId);
                  return;
                }
                const { done, value } = await reader.read();
                if (done) {
                  if (pending.length > 0 && !aborted && !midStreamExpiredPreCommit && !midStreamExpiredPostCommit) {
                    if (pending.includes(EXPIRED_MARKER)) {
                      if (!committed) midStreamExpiredPreCommit = true;
                      else midStreamExpiredPostCommit = true;
                    } else if (pending.endsWith("\n\n")) {
                      try { controller.enqueue(encoder.encode(pending)); } catch { /* closed */ }
                    }
                    pending = "";
                  }
                  break;
                }
                if (aborted) break;
                pending += streamDecoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

                if (pending.length > MAX_PENDING_FRAME_BYTES) {
                  await reader.cancel().catch(() => {});
                  emitTerminalError(controller, "async upstream SSE frame exceeded 1 MiB boundary", "api_error");
                  settleOnce(currentTicket.ticketId);
                  resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
                  return;
                }

                let frameBoundaryFound = false;
                for (;;) {
                  const idx = pending.indexOf("\n\n");
                  if (idx === -1) break;
                  const frame = pending.slice(0, idx + 2);
                  pending = pending.slice(idx + 2);
                  if (frame.includes(EXPIRED_MARKER)) {
                    if (!committed) midStreamExpiredPreCommit = true;
                    else midStreamExpiredPostCommit = true;
                    await reader.cancel().catch(() => {});
                    frameBoundaryFound = true;
                    break;
                  }
                  try {
                    controller.enqueue(encoder.encode(frame));
                    committed = true;
                  } catch {
                    await reader.cancel().catch(() => {});
                    frameBoundaryFound = true;
                    break;
                  }
                }
                if (midStreamExpiredPreCommit || midStreamExpiredPostCommit || frameBoundaryFound) break;
              }
              streamDecoder.decode();
            } finally {
              reader.releaseLock?.();
            }
          }

          if (midStreamExpiredPreCommit && !aborted) {
            log({ phase: "expired", attempt, ticketId: currentTicket.ticketId, message: "expired during LLM (mid-stream, pre-commit)" });
            if (!(await retake())) return;
            continue;
          }

          if (midStreamExpiredPostCommit && !aborted) {
            log({ phase: "error", attempt, ticketId: currentTicket.ticketId, message: "expired mid-stream after commit; cannot retry" });
            settleOnce(currentTicket.ticketId);
            emitTerminalError(controller, "async upstream ticket expired mid-stream after output started", "api_error");
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
            return;
          }

          if (aborted) {
            log({ phase: "abort", attempt, ticketId: currentTicket.ticketId });
            settleOnce(currentTicket.ticketId);
            resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "abort" });
            return;
          }

          log({ phase: "done", attempt, ticketId: currentTicket.ticketId });
          settleOnce(currentTicket.ticketId);
          resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "done" });
          return;
        }
      } catch (err) {
        if (!aborted) emitTerminalError(controller, `async bridge internal error: ${err?.message}`, "api_error");
        settleOnce(currentTicket.ticketId);
        resolveOutcome({ attempts: attempt + 1, finalTicketId: currentTicket.ticketId, terminalPhase: "error" });
      } finally {
        stopKeepalive();
        try { controller.close(); } catch { /* already closed */ }
        resolveOutcome({
          attempts: attempt + 1,
          finalTicketId: currentTicket.ticketId,
          terminalPhase: aborted ? "abort" : "error",
        });
      }
    },

    cancel() {
      aborted = true;
    },
  });

  return { stream, outcome };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}