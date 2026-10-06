// Off-peak (闲时通道) runtime config — env-driven with safe defaults.
// Mirrors zcode-api config.async.* (loader.ts).

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** @returns {object} resolved off-peak config */
export function resolveOffPeakConfig() {
  return {
    enabled: process.env.ZCODE_OFFPEAK_ENABLED !== "0",
    origin: process.env.ZCODE_OFFPEAK_ORIGIN || "https://zcode.z.ai",
    controlTimeoutMs: num(process.env.ZCODE_OFFPEAK_CONTROL_TIMEOUT_MS, 15_000),
    settleTimeoutMs: num(process.env.ZCODE_OFFPEAK_SETTLE_TIMEOUT_MS, 15_000),
    pollIntervalMs: num(process.env.ZCODE_OFFPEAK_POLL_INTERVAL_MS, 2_000),
    keepAliveIntervalMs: num(process.env.ZCODE_OFFPEAK_KEEPALIVE_INTERVAL_MS, 15_000),
    maxRetries: num(process.env.ZCODE_OFFPEAK_MAX_RETRIES, 3),
    // 0 = unlimited total wait budget
    maxWaitMs: num(process.env.ZCODE_OFFPEAK_MAX_WAIT_MS, 0),
    defaultModel: process.env.ZCODE_OFFPEAK_DEFAULT_MODEL || "glm-4.6",
  };
}

/** 4 MiB request-body cap (matches the reference handler). */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;