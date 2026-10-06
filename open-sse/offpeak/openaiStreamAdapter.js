// OpenAI SSE adapter for the off-peak (async) path — ported from zcode-api
// src/async/openai-stream-adapter.ts, reusing 9router's translator registry
// instead of the reference's bundled translators.
//
// Two async-specific concerns on top of `translateResponse(CLAUDE, OPENAI, …)`:
//   1. Preserve `: keepalive` comment frames (the queue-wait liveness signal).
//   2. Convert Anthropic `event: error` frames into an OpenAI
//      `data: {"error":…}` + terminal `[DONE]` (the generic translator drops
//      Anthropic errors, which would mask failures as a clean completion).
//
// One persistent translation state is used for the whole stream.
import { FORMATS } from "../translator/formats.js";
import { translateResponse, initState } from "../translator/index.js";
import { formatSSE } from "../utils/streamHelpers.js";

/**
 * @param {ReadableStream<Uint8Array>} upstream - Anthropic SSE bytes
 * @param {string} [model]
 * @returns {ReadableStream<Uint8Array>}
 */
export function anthropicSseToOpenaiSseWithKeepalive(upstream, model = "glm-4.6") {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state = initState(FORMATS.CLAUDE);
  state.model = model;
  let doneSent = false;
  let errored = false;
  let controller0;

  function emit(out) {
    if (errored) return;
    try { controller0.enqueue(encoder.encode(out)); } catch { /* closed */ }
  }

  function emitDone() {
    if (doneSent) return;
    doneSent = true;
    emit("data: [DONE]\n\n");
  }

  function processFrame(frame) {
    const trimmed = frame.trim();
    if (trimmed === "") return;

    // Pure comment frame — pass through unchanged
    if (trimmed.startsWith(":")) {
      emit(`${frame}\n\n`);
      return;
    }

    // Anthropic error event → OpenAI error + DONE
    if (trimmed.startsWith("event: error") || trimmed.startsWith("event:error")) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      let msg = "unknown error";
      let type = "api_error";
      if (dataLine) {
        try {
          const data = JSON.parse(dataLine.slice(5).trim());
          if (data?.error?.message) msg = String(data.error.message);
          if (data?.error?.type) type = String(data.error.type);
        } catch { /* defaults */ }
      }
      emit(`data: ${JSON.stringify({ error: { message: msg, type } })}\n\n`);
      emitDone();
      errored = true;
      return;
    }

    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    const dataStr = dataLine.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") return;

    let parsed;
    try { parsed = JSON.parse(dataStr); } catch { return; }
    const chunks = translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, parsed, state);
    for (const c of chunks || []) emit(formatSSE(c, "openai"));
  }

  return new ReadableStream({
    start(controller) {
      controller0 = controller;
      const reader = upstream.getReader();
      let buffer = "";
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              processFrame(frame);
              if (errored) break;
            }
            if (errored) break;
          }
          if (!errored) {
            buffer += decoder.decode();
            if (buffer.trim()) processFrame(buffer);
            // Flush translator state, then terminate.
            for (const c of translateResponse(FORMATS.CLAUDE, FORMATS.OPENAI, null, state) || []) {
              emit(formatSSE(c, "openai"));
            }
            emitDone();
          }
        } catch (err) {
          if (!errored) {
            emit(`data: ${JSON.stringify({ error: { message: `async stream error: ${err?.message}`, type: "server_error" } })}\n\n`);
            emitDone();
          }
        } finally {
          reader.releaseLock?.();
          try { controller.close(); } catch { /* closed */ }
        }
      })();
    },
  });
}