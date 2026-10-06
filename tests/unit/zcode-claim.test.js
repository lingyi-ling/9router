import { describe, it, expect, vi, afterEach } from "vitest";

import { classifyClaimCode } from "../../open-sse/claim/types.js";
import { createClaimClient, ClaimPreviewError } from "../../open-sse/claim/client.js";
import { ClaimScheduler } from "../../open-sse/claim/scheduler.js";
import { parseCertifyId, isCaptchaDuplicateError, isCaptchaIpBlockError } from "../../open-sse/captcha/token.js";
import { getCaptchaToken, CaptchaSolverUnavailableError } from "../../open-sse/captcha/solver.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CLIENT_OPTS = { origin: "https://zcode.z.ai", jwt: "jwt-1", appVersion: "3.14.3", platform: "win32-x64" };

describe("claim biz-code classification", () => {
  it("maps known codes and falls back to unknown", () => {
    expect(classifyClaimCode(1003)).toBe("already_claimed");
    expect(classifyClaimCode("1005")).toBe("quota_exhausted");
    expect(classifyClaimCode(3007)).toBe("captcha");
    expect(classifyClaimCode(401)).toBe("login_required");
    expect(classifyClaimCode(9999)).toBe("unknown");
  });
});

describe("claim client", () => {
  it("parses previews and sends only Authorization (no identity bundle)", async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        code: 0,
        data: {
          plans: [
            {
              plan_id: "wk-1",
              name: "Weekend",
              priority: 5,
              starts_at: 100,
              ends_at: 200,
              entitlements: [{ entitlement_id: "e1", show_name: "Tokens", grant_units: 100, unit_type: "K" }],
            },
          ],
        },
      });
    });
    const client = createClaimClient({ ...CLIENT_OPTS, fetchImpl });
    const plans = await client.getPreviews();

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ planId: "wk-1", name: "Weekend", priority: 5, startsAt: 100, endsAt: 200 });
    expect(plans[0].entitlements[0]).toMatchObject({ entitlementId: "e1", grantUnits: 100 });
    expect(captured.url).toContain("/api/v1/zcode-plan/billing/preview?app_version=3.14.3&platform=win32-x64");
    expect(captured.init.headers.Authorization).toBe("Bearer jwt-1");
    expect(captured.init.headers["X-Device-Mid"]).toBeUndefined();
  });

  it("throws ClaimPreviewError with status on 404 (campaign not deployed)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 1001, msg: "not found" }, 404));
    const client = createClaimClient({ ...CLIENT_OPTS, fetchImpl });
    await expect(client.getPreviews()).rejects.toMatchObject({ name: "ClaimPreviewError", status: 404 });
  });

  it("claims successfully and returns the window", async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, init) => {
      captured = { url, init };
      return jsonResponse({ code: 0, data: { plan: { plan_id: "wk-1", starts_at: 10, ends_at: 20 } } });
    });
    const client = createClaimClient({ ...CLIENT_OPTS, fetchImpl });
    const out = await client.claim("wk-1", { verifyParam: "vp", region: "sgp" });

    expect(out).toEqual({ ok: true, planId: "wk-1", startsAt: 10, endsAt: 20 });
    expect(captured.init.headers["X-Aliyun-Captcha-Verify-Param"]).toBe("vp");
    expect(captured.init.headers["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
    expect(captured.init.headers["X-ZCode-App-Version"]).toBe("3.14.3");
    expect(captured.init.headers["X-Platform"]).toBe("win32-x64");
    expect(JSON.parse(captured.init.body)).toEqual({ plan_id: "wk-1" });
  });

  it("classifies a quota_exhausted failure and carries the retry window", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 1005, msg: "quota", data: { plan: { ends_at: 500 } } }));
    const client = createClaimClient({ ...CLIENT_OPTS, fetchImpl });
    const out = await client.claim("wk-1", { verifyParam: "vp" });
    expect(out).toMatchObject({ ok: false, failureKind: "quota_exhausted", code: 1005, failureEndsAt: 500 });
  });

  it("returns login_required when there is no JWT", async () => {
    const client = createClaimClient({ ...CLIENT_OPTS, jwt: undefined, fetchImpl: vi.fn() });
    const out = await client.claim("wk-1", { verifyParam: "vp" });
    expect(out.failureKind).toBe("login_required");
  });
});

describe("claim scheduler", () => {
  const baseCfg = { pollIntervalMs: 1000, cooldownMs: 5000 };

  function deps(overrides = {}) {
    return {
      getJwt: vi.fn(async () => "jwt"),
      createClient: vi.fn(() => ({ getPreviews: vi.fn(async () => []), claim: vi.fn() })),
      getCaptcha: vi.fn(async () => ({ verifyParam: "vp" })),
      config: { ...baseCfg },
      log: vi.fn(),
      ...overrides,
    };
  }

  it("claims the highest-priority plan and holds until ends_at", async () => {
    const client = {
      getPreviews: vi.fn(async () => [
        { planId: "a", priority: 1 },
        { planId: "b", priority: 9 },
      ]),
      claim: vi.fn(async () => ({ ok: true, planId: "b", endsAt: 4000 })),
    };
    const scheduler = new ClaimScheduler(deps({ createClient: () => client }));
    const result = await scheduler.tick();

    expect(result).toMatchObject({ action: "claimed", planId: "b", endsAt: 4000 });
    expect(client.claim).toHaveBeenCalledWith("b", { verifyParam: "vp" });
    expect(scheduler.holdUntil).toBe(4000 * 1000);
  });

  it("holds for the cooldown on a captcha failure (no stop)", async () => {
    const scheduler = new ClaimScheduler(deps({
      createClient: () => ({
        getPreviews: vi.fn(async () => [{ planId: "a", priority: 1 }]),
        claim: vi.fn(async () => ({ ok: false, planId: "a", failureKind: "captcha", code: 3007, message: "bad" })),
      }),
    }));
    const result = await scheduler.tick();
    expect(result).toMatchObject({ action: "failed", holdMs: 5000 });
    expect(scheduler.isStopped()).toBe(false);
  });

  it("stops on login_required", async () => {
    const scheduler = new ClaimScheduler(deps({
      createClient: () => ({
        getPreviews: vi.fn(async () => [{ planId: "a", priority: 1 }]),
        claim: vi.fn(async () => ({ ok: false, planId: "a", failureKind: "login_required", code: 401, message: "no" })),
      }),
    }));
    await scheduler.tick();
    expect(scheduler.isStopped()).toBe(true);
  });

  it("idles (not error) when previews are empty", async () => {
    const scheduler = new ClaimScheduler(deps());
    expect(await scheduler.tick()).toEqual({ action: "idle" });
  });

  it("errors backoff when no JWT is available yet", async () => {
    const scheduler = new ClaimScheduler(deps({ getJwt: vi.fn(async () => undefined) }));
    expect(await scheduler.tick()).toMatchObject({ action: "error", holdMs: 5000 });
  });
});

describe("captcha token helpers", () => {
  it("decodes certifyId from a base64 blob", () => {
    const param = Buffer.from(JSON.stringify({ certifyId: "cid-1" })).toString("base64");
    expect(parseCertifyId(param)).toBe("cid-1");
    expect(parseCertifyId("not-base64-json")).toBeNull();
  });

  it("distinguishes duplicate vs IP-block messages", () => {
    expect(isCaptchaDuplicateError('{"verifyCode":"F008"}')).toBe(true);
    expect(isCaptchaIpBlockError("too many captcha requests")).toBe(true);
    expect(isCaptchaIpBlockError("F008")).toBe(false);
  });
});

describe("captcha solver dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ZCODE_CAPTCHA_SOLVER_URL;
  });

  it("throws an actionable error when no solver is configured", async () => {
    delete process.env.ZCODE_CAPTCHA_SOLVER_URL;
    await expect(getCaptchaToken()).rejects.toBeInstanceOf(CaptchaSolverUnavailableError);
  });

  it("uses the external solver URL when configured", async () => {
    process.env.ZCODE_CAPTCHA_SOLVER_URL = "http://127.0.0.1:9999";
    let captured;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      captured = { url, init };
      return jsonResponse({ verifyParam: "vp-xyz" });
    }));
    const token = await getCaptchaToken();
    expect(token.verifyParam).toBe("vp-xyz");
    expect(captured.url).toBe("http://127.0.0.1:9999/solve");
  });
});