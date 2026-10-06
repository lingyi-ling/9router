// Manual-claim runtime config — env-driven with safe defaults.
// Mirrors zcode-api config.claim.* (loader.ts).

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function resolveClaimConfig() {
  return {
    enabled: process.env.ZCODE_CLAIM_ENABLED !== "0",
    origin: process.env.ZCODE_CLAIM_ORIGIN || "https://zcode.z.ai",
    // Empty = claim the highest-priority preview plan.
    planId: process.env.ZCODE_CLAIM_PLAN_ID || "",
    pollIntervalMs: num(process.env.ZCODE_CLAIM_POLL_INTERVAL_MS, 60_000),
    cooldownMs: num(process.env.ZCODE_CLAIM_COOLDOWN_MS, 5 * 60_000),
    appVersion: process.env.ZCODE_APP_VERSION || "3.14.3",
    deviceMid: process.env.ZCODE_IDENTITY_DEVICE_MID || undefined,
  };
}