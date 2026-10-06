// Manual-claim wiring — ported (adapted) from zcode-api src/claim/runtime.ts.
// Builds a claim gateway / auto-claim scheduler from the shared ZCode
// credential + env config. Credential resolution is injected by the caller so
// this module stays inside the open-sse engine layer.
import { createClaimClient } from "./client.js";
import { ClaimScheduler } from "./scheduler.js";
import { getCaptchaToken } from "../captcha/solver.js";

/** `${process.platform}-${process.arch}` — mirrors the client's platform id. */
export function claimPlatform() {
  return `${process.platform}-${process.arch}`;
}

/** Build a one-shot claim gateway from a JWT + config. */
export function createClaimGateway(jwt, cfg) {
  return createClaimClient({
    origin: cfg.origin,
    jwt,
    appVersion: cfg.appVersion,
    platform: claimPlatform(),
    deviceMid: cfg.deviceMid,
  });
}

/**
 * Build an auto-claim scheduler.
 * @param {object} deps
 * @param {() => Promise<string|undefined>} deps.getJwt
 * @param {object} deps.cfg - resolveClaimConfig() output
 * @param {(msg:string)=>void} [deps.log]
 */
export function createClaimScheduler({ getJwt, cfg, log }) {
  return new ClaimScheduler({
    getJwt,
    createClient: (jwt) => createClaimGateway(jwt, cfg),
    getCaptcha: async () => {
      const token = await getCaptchaToken();
      return { verifyParam: token.verifyParam, region: token.region || undefined };
    },
    config: {
      planId: cfg.planId || undefined,
      pollIntervalMs: cfg.pollIntervalMs,
      cooldownMs: cfg.cooldownMs,
    },
    log: log || ((m) => console.log(`[claim] ${m}`)),
  });
}