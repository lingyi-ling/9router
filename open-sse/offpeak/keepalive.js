// SSE keepalive frames for the off-peak bridge — ported from zcode-api
// src/async/keepalive.ts.
//
// Emits pure SSE comment frames (`: keepalive\n\n`) which every spec-compliant
// SSE client ignores, but which reset their idle-timeout timers during a long
// ticket-queue wait. NEVER emits `data:` frames — those carry semantic events
// and would break strict SDK parsers.

/**
 * Single immediate keepalive frame.
 * @param {string} [text]
 * @returns {Uint8Array}
 */
export function keepaliveFrame(text = "keepalive") {
  const clean = String(text).replace(/[\r\n]/g, " ");
  return new TextEncoder().encode(`: ${clean}\n\n`);
}

/**
 * Build a ReadableStream emitting `: {text}\n\n` every intervalMs. Closes when
 * `signal` aborts. First emit happens AFTER intervalMs (not immediately).
 * @param {{ intervalMs: number, text?: string, signal?: AbortSignal }} opts
 * @returns {ReadableStream<Uint8Array>}
 */
export function keepaliveStream(opts) {
  const text = (opts.text ?? "keepalive").replace(/[\r\n]/g, " ");
  const frame = new TextEncoder().encode(`: ${text}\n\n`);
  let timer;
  let aborted = false;

  return new ReadableStream({
    start(controller) {
      if (opts.signal) {
        if (opts.signal.aborted) {
          aborted = true;
          controller.close();
          return;
        }
        opts.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            if (timer) {
              clearTimeout(timer);
              timer = undefined;
            }
            try { controller.close(); } catch { /* already closed */ }
          },
          { once: true },
        );
      }

      const tick = () => {
        if (aborted) return;
        try {
          controller.enqueue(frame);
        } catch {
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          return;
        }
        timer = setTimeout(tick, opts.intervalMs);
      };
      timer = setTimeout(tick, opts.intervalMs);
    },
    cancel() {
      aborted = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  });
}