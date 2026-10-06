import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("@/sse/services/auth.js", () => ({
  extractApiKey: vi.fn(),
  isValidApiKey: vi.fn(),
}));

import { getProviderConnections, getSettings } from "@/lib/localDb";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth.js";
import {
  ZCODE_MCP_CATALOGUE,
  lookupZcodeMcpServer,
  resolveZcodeMcpUpstreamPath,
  resolveZcodeMcpUpstreamOrigin,
} from "@/lib/mcp/zcodeOfficialCatalogue.js";
import {
  buildZcodeMcpAuthHeaders,
  resolveZcodeMcpCredential,
  relayZcodeMcpRequest,
  authorizeMcpRequest,
} from "@/lib/mcp/zcodeRelay.js";

describe("official ZCode MCP catalogue", () => {
  it("lists the 15 official plugin servers and looks them up by key", () => {
    expect(ZCODE_MCP_CATALOGUE.servers).toHaveLength(15);
    const tianyancha = lookupZcodeMcpServer("tianyancha");
    expect(tianyancha.routeId).toBe("finance_tianyancha");
    expect(resolveZcodeMcpUpstreamPath(tianyancha)).toBe("/api/v1/mcp/server/finance_tianyancha");
    expect(lookupZcodeMcpServer("nope")).toBeNull();
  });

  it("defaults the upstream origin to zcode.z.ai with env override", () => {
    expect(resolveZcodeMcpUpstreamOrigin()).toBe("https://zcode.z.ai");
    process.env.ZCODE_MCP_UPSTREAM_ORIGIN = "https://example.test";
    expect(resolveZcodeMcpUpstreamOrigin()).toBe("https://example.test");
    delete process.env.ZCODE_MCP_UPSTREAM_ORIGIN;
  });
});

describe("ZCode MCP credential resolution + auth headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers a glm connection carrying a zcode JWT", async () => {
    getProviderConnections.mockImplementation(async ({ provider }) =>
      provider === "glm"
        ? [
            {
              provider: "glm",
              accessToken: "plan.key",
              providerSpecificData: { zcodeJwtToken: "jwt-abc" },
            },
          ]
        : [],
    );

    const cred = await resolveZcodeMcpCredential();
    expect(cred).toEqual({ jwt: "jwt-abc", planKey: "plan.key", provider: "glm" });

    const headers = buildZcodeMcpAuthHeaders(cred);
    expect(headers).toEqual({
      Authorization: "Bearer jwt-abc",
      "X-Bigmodel-Authorization": "Bearer plan.key",
      "Bigmodel-Target-Type": "PERSONAL",
    });
  });

  it("falls back to glm-cn and returns null when no JWT exists", async () => {
    getProviderConnections.mockImplementation(async ({ provider }) =>
      provider === "glm-cn"
        ? [
            { provider: "glm-cn", accessToken: "k.secret", providerSpecificData: { zcodeJwtToken: "jwt-cn" } },
          ]
        : [{ provider: "glm", accessToken: "x", providerSpecificData: {} }],
    );
    const cred = await resolveZcodeMcpCredential();
    expect(cred.provider).toBe("glm-cn");

    getProviderConnections.mockResolvedValue([]);
    expect(await resolveZcodeMcpCredential()).toBeNull();
  });
});

describe("ZCode MCP relay forwarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards MCP headers, drops inbound authorization, and injects credentials", async () => {
    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        captured = { url, init };
        return new Response("data: ok\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" },
        });
      }),
    );

    const req = new Request("https://local.test/mcp/tianyancha?x=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer LEAKED",
        "mcp-session-id": "s-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const upstreamUrl = "https://zcode.z.ai/api/v1/mcp/server/finance_tianyancha?x=1";
    const res = await relayZcodeMcpRequest(req, buildZcodeMcpAuthHeaders({ jwt: "J", planKey: "P" }), upstreamUrl);

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s-1");
    expect(captured.url).toBe(upstreamUrl);
    // inbound api key must never reach upstream; our credential wins
    expect(captured.init.headers.Authorization).toBe("Bearer J");
    expect(captured.init.headers.authorization).toBeUndefined();
    expect(captured.init.headers["X-Bigmodel-Authorization"]).toBe("Bearer P");
    expect(captured.init.headers["content-type"]).toBe("application/json");
    // body forwarded verbatim
    expect(Buffer.from(captured.init.body).toString()).toContain("initialize");
  });

  it("returns 502 mcp_upstream_unreachable when the gateway throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const req = new Request("https://local.test/mcp/tianyancha", { method: "POST", body: "{}" });
    const res = await relayZcodeMcpRequest(req, buildZcodeMcpAuthHeaders({ jwt: "J", planKey: "P" }), "https://zcode.z.ai/x");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.type).toBe("mcp_upstream_unreachable");
  });
});

describe("ZCode MCP inbound auth gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is open when requireApiKey is off", async () => {
    getSettings.mockResolvedValue({ requireApiKey: false });
    expect(await authorizeMcpRequest(new Request("https://local.test/mcp"))).toBeNull();
  });

  it("rejects a missing or invalid key when requireApiKey is on", async () => {
    getSettings.mockResolvedValue({ requireApiKey: true });
    extractApiKey.mockReturnValue(null);
    let res = await authorizeMcpRequest(new Request("https://local.test/mcp"));
    expect(res.status).toBe(401);

    extractApiKey.mockReturnValue("bad");
    isValidApiKey.mockResolvedValue(false);
    res = await authorizeMcpRequest(new Request("https://local.test/mcp"));
    expect(res.status).toBe(401);

    isValidApiKey.mockResolvedValue(true);
    expect(await authorizeMcpRequest(new Request("https://local.test/mcp"))).toBeNull();
  });
});