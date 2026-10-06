import { describe, it, expect, vi, afterEach } from "vitest";

import glmCnOauthProvider from "../../src/lib/oauth/providers/glm-cn.js";
import { getProvider } from "../../src/lib/oauth/providers";
import { PROVIDERS as TRANSPORTS, PROVIDER_OAUTH, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { applyGlmBodyAlignment } from "../../open-sse/utils/glmBodyAlign.js";

const PLAN_KEY = "bmkey.secret";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("glm-cn registry entry (Bigmodel dual-auth)", () => {
  it("is an oauth provider with the CLI poll endpoints + bigmodel derivation config", () => {
    expect(PROVIDER_OAUTH["glm-cn"]).toBeDefined();
    const oauth = PROVIDER_OAUTH["glm-cn"];
    expect(oauth.providerId).toBe("bigmodel");
    expect(oauth.cliInitUrl).toBe("https://zcode.z.ai/api/v1/oauth/cli/init");
    expect(oauth.cliPollUrl).toBe("https://zcode.z.ai/api/v1/oauth/cli/poll");
    expect(oauth.apiBaseUrl).toBe("https://bigmodel.cn");
    expect(oauth.requireSecretKey).toBe(false);
    // Bigmodel has no z/login business exchange
    expect(oauth.businessLoginUrl).toBeUndefined();
  });

  it("exposes an openai + claude transport (sourceFormat-matched, zero translation)", () => {
    const transports = TRANSPORTS["glm-cn"].transports;
    const openai = transports.find((t) => t.format === "openai");
    const claude = transports.find((t) => t.format === "claude");
    expect(openai.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
    expect(claude.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
    expect(claude.auth.header).toBe("x-api-key");
  });

  it("is wired into the generic OAuth provider registry", () => {
    expect(getProvider("glm-cn")).toBe(glmCnOauthProvider);
  });

  it("lists the full GLM model set on both glm and glm-cn", () => {
    for (const id of ["glm-4.6", "glm-4.5-air", "glm-5v-turbo"]) {
      expect(PROVIDER_MODELS.glm.some((m) => m.id === id)).toBe(true);
      expect(PROVIDER_MODELS["glm-cn"].some((m) => m.id === id)).toBe(true);
    }
  });
});

describe("glm-cn OAuth flow (Bigmodel variant)", () => {
  let calls;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch({ copyFails = false } = {}) {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const entry = { url: String(url), method: init.method || "GET", init };
        calls.push(entry);
        const u = new URL(url);

        if (u.href === "https://zcode.z.ai/api/v1/oauth/cli/init") {
          return jsonResponse({
            code: 0,
            data: {
              authorize_url: "https://bigmodel.cn/oauth/authorize?x=1",
              flow_id: "flow-bm",
              poll_interval_sec: 2,
              expires_at: Math.floor(Date.now() / 1000) + 300,
            },
          });
        }
        if (u.pathname.startsWith("/api/v1/oauth/cli/poll/")) {
          return jsonResponse({
            code: 0,
            data: {
              status: "ready",
              token: "zcode-jwt-bm",
              user: { user_id: "u-bm", name: "BM", email: "bm@example.com" },
              // NOTE: provider payload nested under the providerId ("bigmodel")
              bigmodel: { access_token: "bm-oauth-token" },
            },
          });
        }
        if (u.href === "https://bigmodel.cn/api/biz/customer/getCustomerInfo") {
          return jsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "bm-org",
                  organizationName: "默认机构",
                  projects: [{ projectId: "bm-proj", projectName: "默认项目", projectType: "1" }],
                },
              ],
            },
          });
        }
        if (u.pathname.endsWith("/api_keys") && entry.method === "GET") {
          return jsonResponse({ code: 200, data: [] });
        }
        if (u.pathname.endsWith("/api_keys")) {
          return jsonResponse({ code: 200, data: { apiKey: "bmkey", name: "zcode-api-key" } });
        }
        if (u.pathname.endsWith("/copy/bmkey")) {
          if (copyFails) return jsonResponse({ code: 500, msg: "copy disabled" }, 500);
          return jsonResponse({ code: 200, data: { secretKey: "secret" } });
        }
        return jsonResponse({ code: 500, msg: `unexpected ${url}` }, 500);
      }),
    );
  }

  it("sends provider:\"bigmodel\" on init", async () => {
    stubFetch();
    await glmCnOauthProvider.requestDeviceCode(glmCnOauthProvider.config);
    expect(JSON.parse(calls[0].init.body)).toEqual({ provider: "bigmodel" });
  });

  it("derives the plan key via bigmodel.cn with a raw (unprefixed) Authorization header", async () => {
    stubFetch();
    const result = await glmCnOauthProvider.pollToken(glmCnOauthProvider.config, "flow-bm", null, {
      _zcodePollToken: "t",
    });

    expect(result.data.access_token).toBe(PLAN_KEY);

    const bizCall = calls.find((c) => c.url.includes("bigmodel.cn/api/biz/customer/getCustomerInfo"));
    expect(bizCall).toBeTruthy();
    // raw token, NOT "Bearer <token>"
    expect(bizCall.init.headers.Authorization).toBe("bm-oauth-token");
  });

  it("falls back to the plain apiKey when the secretKey copy fails (best-effort)", async () => {
    stubFetch({ copyFails: true });
    const result = await glmCnOauthProvider.pollToken(glmCnOauthProvider.config, "flow-bm", null, {
      _zcodePollToken: "t",
    });
    expect(result.data.access_token).toBe("bmkey");
  });
});

describe("GLM outbound body alignment (official-client parity)", () => {
  it("injects stream_options.include_usage for OpenAI streaming", () => {
    const body = { stream: true, messages: [{ role: "user", content: "hi" }] };
    applyGlmBodyAlignment("glm", body, "openai", {});
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("does not add stream_options for non-streaming OpenAI requests", () => {
    const body = { stream: false, messages: [] };
    applyGlmBodyAlignment("glm", body, "openai", {});
    expect(body.stream_options).toBeUndefined();
  });

  it("clears stale cache_control and marks the last non-system block (Anthropic)", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
        { role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
      ],
    };
    applyGlmBodyAlignment("glm-cn", body, "claude", {});
    // stale marker on the first user block is cleared
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    // last non-system message's last block is marked
    expect(body.messages[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    // system field untouched
    expect(body.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("injects metadata.user_id only when a device/session id is present", () => {
    const withIds = { messages: [], };
    applyGlmBodyAlignment("glm", withIds, "claude", {
      providerSpecificData: { deviceMid: "mid-1", sessionId: "sess-1" },
    });
    expect(JSON.parse(withIds.metadata.user_id)).toEqual({
      device_id: "mid-1",
      account_uuid: "",
      session_id: "sess-1",
    });

    const withoutIds = { messages: [] };
    applyGlmBodyAlignment("glm", withoutIds, "claude", { providerSpecificData: {} });
    expect(withoutIds.metadata).toBeUndefined();
  });

  it("is a no-op for other providers", () => {
    const body = { stream: true, messages: [] };
    applyGlmBodyAlignment("deepseek", body, "openai", {});
    expect(body.stream_options).toBeUndefined();
  });

  it("is invoked through the default executor using the runtime transport format", () => {
    const executor = new DefaultExecutor("glm");
    const credentials = {
      accessToken: PLAN_KEY,
      runtimeTransport: { format: "openai" },
    };
    const out = executor.transformRequest("glm-4.6", { stream: true, messages: [] }, true, credentials);
    expect(out.stream_options).toEqual({ include_usage: true });
  });
});