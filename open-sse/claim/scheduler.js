// Auto-claim scheduler — ported from zcode-api src/claim/scheduler.ts.
//
// Polls the manual-claim preview endpoint and claims weekend/trial plans the
// moment they become available (first-come-first-served; the server caps daily
// claims with biz code 1005).
//
// Backoff per failure kind:
//   success / already_claimed → hold until the plan's ends_at (unix sec)
//   quota_exhausted           → hold until failureEndsAt (next window) else cooldown
//   ineligible / unavailable / not_found / captcha / unknown → cooldown
//   login_required            → stop (needs re-login)
//
// starts_at / ends_at / failureEndsAt are unix SECONDS.
import { ClaimPreviewError } from "./client.js";

export class ClaimScheduler {
  /**
   * @param {object} deps
   * @param {() => Promise<string|undefined>} deps.getJwt
   * @param {(jwt:string) => {getPreviews:Function, claim:Function}} deps.createClient
   * @param {() => Promise<{verifyParam:string, region?:string}>} deps.getCaptcha
   * @param {{planId?:string, pollIntervalMs:number, cooldownMs:number}} deps.config
   * @param {(msg:string)=>void} [deps.log]
   * @param {()=>number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps;
    this.stopped = false;
    this.holdUntil = 0;
    this.timer = null;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  isStopped() {
    return this.stopped;
  }

  start() {
    if (this.stopped) return;
    this.scheduleNext(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One poll→claim cycle (exposed for tests). */
  async tick() {
    if (this.stopped) return { action: "stopped" };
    const nowMs = this.now();
    if (nowMs < this.holdUntil) return { action: "skipped_hold" };

    let jwt;
    try {
      jwt = await this.deps.getJwt();
    } catch (err) {
      return this.errorBackoff(`credential resolution failed: ${err?.message}`);
    }
    if (!jwt) return this.errorBackoff("no JWT available (oauth login pending)");

    const client = this.deps.createClient(jwt);
    let plans;
    try {
      plans = await client.getPreviews();
    } catch (err) {
      // 404 = campaign endpoint not deployed yet (expected pre-launch) → poll normally.
      if (err instanceof ClaimPreviewError && err.status === 404) {
        this.holdUntil = nowMs + this.deps.config.pollIntervalMs;
        return { action: "idle" };
      }
      return this.errorBackoff(`preview failed: ${err?.message}`);
    }
    if (plans.length === 0) {
      this.holdUntil = nowMs + this.deps.config.pollIntervalMs;
      return { action: "idle" };
    }

    const target = this.pickPlan(plans);
    if (!target) {
      this.holdUntil = nowMs + this.deps.config.pollIntervalMs;
      return { action: "idle" };
    }

    let captcha;
    try {
      captcha = await this.deps.getCaptcha();
    } catch (err) {
      return this.errorBackoff(`captcha token failed: ${err?.message}`);
    }

    let outcome;
    try {
      outcome = await client.claim(target.planId, captcha);
    } catch (err) {
      return this.errorBackoff(`claim request failed: ${err?.message}`);
    }

    if (outcome.ok) {
      const endsAtMs = outcome.endsAt !== undefined ? outcome.endsAt * 1000 : undefined;
      this.holdUntil = endsAtMs ?? nowMs + this.deps.config.pollIntervalMs;
      this.log(`claim: claimed plan ${target.planId}${outcome.startsAt !== undefined ? ` (activates ${new Date(outcome.startsAt * 1000).toISOString()})` : ""}`);
      return { action: "claimed", planId: target.planId, startsAt: outcome.startsAt, endsAt: outcome.endsAt };
    }

    const holdMs = this.holdForFailure(outcome.failureKind, outcome.failureEndsAt, nowMs);
    this.holdUntil = nowMs + holdMs;
    this.log(`claim: ${outcome.failureKind} (${outcome.code}) — ${outcome.message}; retry in ${Math.round(holdMs / 1000)}s`);
    if (outcome.failureKind === "login_required") this.stop();
    return { action: "failed", outcome, holdMs };
  }

  pickPlan(plans) {
    const wanted = this.deps.config.planId?.trim();
    if (wanted) return plans.find((p) => p.planId === wanted) ?? null;
    return [...plans].sort((a, b) => b.priority - a.priority)[0] ?? null;
  }

  holdForFailure(kind, failureEndsAtSec, nowMs) {
    if ((kind === "already_claimed" || kind === "quota_exhausted") && Number.isFinite(failureEndsAtSec)) {
      const untilMs = failureEndsAtSec * 1000;
      if (untilMs > nowMs) return Math.min(untilMs - nowMs, 24 * 60 * 60 * 1000);
    }
    return this.deps.config.cooldownMs;
  }

  errorBackoff(message) {
    const holdMs = this.deps.config.cooldownMs;
    this.holdUntil = this.now() + holdMs;
    this.log(`claim: ${message}; retry in ${Math.round(holdMs / 1000)}s`);
    return { action: "error", message, holdMs };
  }

  scheduleNext(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext(this.nextDelay()));
    }, delayMs);
  }

  nextDelay() {
    const remaining = this.holdUntil - this.now();
    return remaining > 0 ? remaining : this.deps.config.pollIntervalMs;
  }
}