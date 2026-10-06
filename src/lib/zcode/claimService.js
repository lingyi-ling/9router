// 9router-side glue for the manual-claim subsystem: credential resolution +
// a process-wide auto-claim scheduler singleton. The heavy lifting lives in
// open-sse/claim/*; this module bridges it to the app's connection store.
import { resolveClaimConfig, createClaimGateway, createClaimScheduler } from "open-sse/claim/service.js";
import { ClaimPreviewError } from "open-sse/claim/client.js";
import { getCaptchaToken, CaptchaSolverUnavailableError } from "open-sse/captcha/solver.js";
import { resolveZcodeCredential } from "./credentials.js";

let scheduler = null;

export function claimSchedulerStatus() {
  if (!scheduler) return "idle";
  return scheduler.isStopped() ? "stopped" : "running";
}

/** Start the auto-claim scheduler (idempotent while running). */
export function startClaimScheduler() {
  const cfg = resolveClaimConfig();
  if (!cfg.enabled) return { started: false, status: claimSchedulerStatus(), error: "claim is disabled (ZCODE_CLAIM_ENABLED=0)" };
  if (scheduler && !scheduler.isStopped()) return { started: false, status: "running" };
  scheduler = createClaimScheduler({
    getJwt: async () => (await resolveZcodeCredential())?.jwt,
    cfg,
    log: (m) => console.log(`[claim] ${m}`),
  });
  scheduler.start();
  return { started: true, status: "running" };
}

export function stopClaimScheduler() {
  if (scheduler) scheduler.stop();
  return { status: claimSchedulerStatus() };
}

/** List currently claimable plans (for the dashboard). */
export async function listClaimPreviews() {
  const cfg = resolveClaimConfig();
  const cred = await resolveZcodeCredential();
  const client = createClaimGateway(cred?.jwt, cfg);
  try {
    const plans = await client.getPreviews();
    return { ok: true, plans, loggedIn: Boolean(cred?.jwt) };
  } catch (err) {
    if (err instanceof ClaimPreviewError) {
      return { ok: false, error: err.message, status: err.status, code: err.code, campaignNotDeployed: err.status === 404 };
    }
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * One-shot claim (dashboard "立即抢" / scheduler tick equivalent).
 * @param {string} [planId] - empty = highest-priority preview plan
 */
export async function claimNow(planId) {
  const cfg = resolveClaimConfig();
  const cred = await resolveZcodeCredential();
  if (!cred?.jwt) return { ok: false, failureKind: "login_required", message: "no OAuth credential with a ZCode JWT — log in with glm / glm-cn" };

  const client = createClaimGateway(cred.jwt, cfg);
  let plans;
  try {
    plans = await client.getPreviews();
  } catch (err) {
    if (err instanceof ClaimPreviewError) {
      return { ok: false, failureKind: err.status === 404 ? "unavailable" : "http_error", code: err.code, message: err.message };
    }
    throw err;
  }
  const wanted = planId?.trim();
  const target = wanted
    ? plans.find((p) => p.planId === wanted)
    : [...plans].sort((a, b) => b.priority - a.priority)[0];
  if (!target) return { ok: false, failureKind: "not_found", message: wanted ? `plan "${wanted}" not in preview list` : "no claimable plans right now" };

  let captcha;
  try {
    captcha = await getCaptchaToken();
  } catch (err) {
    if (err instanceof CaptchaSolverUnavailableError) {
      return { ok: false, failureKind: "captcha", message: err.message };
    }
    return { ok: false, failureKind: "captcha", message: `captcha token failed: ${err?.message}` };
  }

  return client.claim(target.planId, { verifyParam: captcha.verifyParam, region: captcha.region || undefined });
}