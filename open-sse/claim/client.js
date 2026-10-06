// Manual-claim billing HTTP client — ported from zcode-api src/claim/client.ts.
//
// Mirrors the ZCode desktop client's getManualClaimPlanPreviews / claimManualPlan
// exactly (minimal header set, NOT the identity bundle):
//   GET  {origin}/api/v1/zcode-plan/billing/preview?app_version=&platform=
//          headers: Authorization: Bearer {jwt} only (omitted when anonymous)
//   POST {origin}/api/v1/zcode-plan/billing/claim   body {plan_id}
//          headers: Authorization, Content-Type, X-Aliyun-Captcha-Verify-Param,
//          [X-Aliyun-Captcha-Verify-Region], X-ZCode-App-Version, X-Platform
//
// Campaign-gated deviation (0828 + 0918): when `deviceMid` is set, append a
// UUID X-Device-Mid — the gateway rejects preview with biz 3001 otherwise.
import { classifyClaimCode } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Preview failure with the HTTP status preserved (404 = campaign not deployed). */
export class ClaimPreviewError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ClaimPreviewError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.origin
 * @param {string} [opts.jwt]
 * @param {string} opts.appVersion
 * @param {string} opts.platform
 * @param {string} [opts.deviceMid]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createClaimClient(opts) {
  const origin = String(opts.origin || "").replace(/\/+$/, "");
  const jwt = opts.jwt?.trim() || undefined;
  const deviceMid = opts.deviceMid?.trim() || undefined;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  function parseEntitlement(c) {
    const entitlementId = c.entitlement_id?.trim() ?? "";
    if (!entitlementId) return null;
    const e = {
      entitlementId,
      showName: c.show_name?.trim() ?? "",
      meter: c.meter?.trim() ?? "",
      unitType: c.unit_type?.trim() ?? "",
      capabilities: Array.isArray(c.capabilities) ? c.capabilities : [],
      grantUnits: Number.isFinite(c.grant_units) ? c.grant_units : 0,
      period: c.period?.trim() ?? "",
      priority: Number.isFinite(c.priority) ? c.priority : 0,
    };
    if (Number.isFinite(c.effective_at)) e.effectiveAt = c.effective_at;
    return e;
  }

  function parsePlan(p) {
    const planId = p.plan_id?.trim() ?? "";
    if (!planId) return null;
    const plan = {
      planId,
      name: p.name?.trim() || planId,
      description: p.description?.trim() ?? "",
      priority: Number.isFinite(p.priority) ? p.priority : 0,
      entitlements: (p.entitlements ?? []).flatMap((c) => {
        const e = parseEntitlement(c);
        return e ? [e] : [];
      }),
    };
    if (Number.isFinite(p.starts_at)) plan.startsAt = p.starts_at;
    if (Number.isFinite(p.ends_at)) plan.endsAt = p.ends_at;
    return plan;
  }

  async function request(method, path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (init.signal) {
      if (init.signal.aborted) controller.abort();
      else init.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const resp = await fetchImpl(`${origin}${path}`, {
        method,
        headers: init.headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await resp.text();
      let json;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") json = parsed;
      } catch { /* non-JSON body surfaced via text */ }
      return { status: resp.status, json, text };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function unwrapError(json, status, text) {
    const code = json?.code !== undefined ? json.code : status >= 400 ? status : -1;
    const rawMsg = json?.msg ?? json?.message;
    const message = typeof rawMsg === "string" && rawMsg.trim() ? rawMsg.trim() : text.length > 0 && text.length < 200 ? text : `HTTP ${status}`;
    return { code, message };
  }

  return {
    async getPreviews(signal) {
      const url = `/api/v1/zcode-plan/billing/preview?app_version=${encodeURIComponent(opts.appVersion)}&platform=${encodeURIComponent(opts.platform)}`;
      const headers = jwt ? { Authorization: `Bearer ${jwt}` } : {};
      if (deviceMid) headers["X-Device-Mid"] = deviceMid;
      const { status, json, text } = await request("GET", url, { headers, signal });
      if (status < 200 || status >= 300 || (json?.code !== undefined && json.code !== 0) || json?.data === undefined) {
        const { code, message } = unwrapError(json, status, text);
        throw new ClaimPreviewError(`claim preview failed (${code}): ${message}`, status, code);
      }
      const data = json.data;
      return (data.plans ?? []).flatMap((p) => {
        const plan = parsePlan(p);
        return plan ? [plan] : [];
      });
    },

    async claim(planId, captcha, signal) {
      if (!jwt) return { ok: false, planId, failureKind: "login_required", code: 401, message: "manual_claim_login_required" };
      const headers = {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-Aliyun-Captcha-Verify-Param": captcha.verifyParam,
      };
      if (captcha.region) headers["X-Aliyun-Captcha-Verify-Region"] = captcha.region;
      headers["X-ZCode-App-Version"] = opts.appVersion;
      headers["X-Platform"] = opts.platform;
      if (deviceMid) headers["X-Device-Mid"] = deviceMid;
      const { status, json, text } = await request("POST", "/api/v1/zcode-plan/billing/claim", { body: { plan_id: planId }, headers, signal });

      const data = json?.data;
      const bizCode = json?.code !== undefined ? json.code : undefined;
      const plan = data?.plan;
      if (status >= 200 && status < 300 && bizCode === 0 && plan) {
        const out = { ok: true, planId };
        if (Number.isFinite(plan.starts_at)) out.startsAt = plan.starts_at;
        if (Number.isFinite(plan.ends_at)) out.endsAt = plan.ends_at;
        return out;
      }
      const { code, message } = unwrapError(json, status, text);
      const failureEndsAt = Number.isFinite(plan?.ends_at) ? plan.ends_at : undefined;
      const httpDerived = status >= 400 && bizCode === undefined;
      return {
        ok: false,
        planId,
        failureKind: httpDerived ? (status === 401 ? "login_required" : "http_error") : classifyClaimCode(code),
        code,
        message,
        ...(failureEndsAt !== undefined ? { failureEndsAt } : {}),
      };
    },
  };
}