import { describe, it, expect, vi } from "vitest";

import {
  createCodeBuddyClient,
  deriveAccountStableId,
  isAlreadyCheckin,
  isBuddyTaskIncomplete,
  CodeBuddyError,
  CB_ERROR_KIND,
  CODEBUDDY_BASES,
} from "../../open-sse/codebuddy/upstream/client.js";
import { parseGrowthTasks, acceptTasks, claimReward, claimRewardMP } from "../../open-sse/codebuddy/upstream/tasks.js";
import { travelStatus, buddyFirst, growthStreak } from "../../open-sse/codebuddy/upstream/travel.js";
import { redeemTier, lotteryChances } from "../../open-sse/codebuddy/upstream/streak.js";
import { runCheckinAll, runActivityAll, runKeepaliveAll } from "../../open-sse/codebuddy/scheduler.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const ok = (data = {}) => jsonResponse({ code: 0, msg: "ok", data });

function makeClient(fetchImpl, extra = {}) {
  return createCodeBuddyClient({
    accessToken: "at-1",
    refreshToken: "rt-1",
    uid: "uid-1",
    enterpriseId: "ent-1",
    realm: "cn",
    fetchImpl,
    ...extra,
  });
}

describe("codebuddy upstream client", () => {
  it("derives stable per-uid device ids (36 hex, deterministic)", () => {
    const a = deriveAccountStableId("uid-1", "machine");
    expect(a).toHaveLength(36);
    expect(a).toBe(deriveAccountStableId("uid-1", "machine"));
    expect(a).not.toBe(deriveAccountStableId("uid-2", "machine"));
    expect(a).not.toBe(deriveAccountStableId("uid-1", "session"));
  });

  it("routes CN vs global base URLs", () => {
    const cn = makeClient(vi.fn());
    const gl = makeClient(vi.fn(), { realm: "global" });
    expect(cn.baseUrls.chat).toBe(CODEBUDDY_BASES.chatCN);
    expect(cn.baseUrls.billing).toBe(CODEBUDDY_BASES.billingCN);
    expect(gl.baseUrls.chat).toBe(CODEBUDDY_BASES.global);
  });

  it("sends billing headers with bearer + uid + account-stable device headers", async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, init) => { captured = { url, init }; return ok({}); });
    const client = makeClient(fetchImpl);
    await client.dailyCheckin();
    expect(captured.url).toBe(`${CODEBUDDY_BASES.billingCN}/v2/billing/meter/daily-checkin`);
    expect(captured.init.headers.Authorization).toBe("Bearer at-1");
    expect(captured.init.headers["X-User-Id"]).toBe("uid-1");
    expect(captured.init.headers["X-CodeBuddy-Request"]).toBe("1");
    // 账号级稳定设备头只在 common 头族（chat 域）；billing 域按 Go 语义不注入
    expect(client.commonHeaders()["X-Machine-ID"]).toBe(deriveAccountStableId("uid-1", "machine"));
    expect(captured.init.headers["X-Machine-ID"]).toBeUndefined();
  });

  it("unwraps {code,data} and raises classified errors", async () => {
    const client = makeClient(vi.fn(async () => ok({ hello: 1 })));
    const data = await client.growthJSON("GET", "/x");
    expect(data).toEqual({ hello: 1 });

    const bad = makeClient(vi.fn(async () => jsonResponse({ code: 1005, msg: "quota" })));
    await expect(bad.growthJSON("GET", "/x")).rejects.toMatchObject({ kind: CB_ERROR_KIND.CLIENT });

    const notFound = makeClient(vi.fn(async () => jsonResponse({ msg: "nope" }, 404)));
    await expect(notFound.growthJSON("GET", "/x")).rejects.toMatchObject({ kind: CB_ERROR_KIND.NOT_FOUND, status: 404 });
  });

  it("recognises the already-checked-in idempotent error", async () => {
    const client = makeClient(vi.fn(async () => jsonResponse({ code: 14001, msg: "今天已签到" })));
    try {
      await client.dailyCheckin();
      throw new Error("should have thrown");
    } catch (err) {
      expect(isAlreadyCheckin(err)).toBe(true);
    }
  });

  it("report body carries the full chat_request_send shape with userId", async () => {
    let captured;
    const client = makeClient(vi.fn(async (url, init) => { captured = { url, init }; return ok({}); }));
    await client.reportChatActivity("conv-1", "req-1", "glm-5.2", "GLM 5.2");
    const body = JSON.parse(captured.init.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({
      eventCode: "chat_request_send",
      conversationId: "conv-1",
      requestId: "req-1",
      requestModelId: "glm-5.2",
      userId: "uid-1",
      mode: "craft",
    });
    expect(captured.init.headers["X-User-Id"]).toBe("uid-1");
  });

  it("refreshes the token via the plugin refresh endpoint", async () => {
    let captured;
    const client = makeClient(vi.fn(async (url, init) => { captured = { url, init }; return ok({ accessToken: "at-2", refreshToken: "rt-2", expiresIn: 100 }); }));
    const t = await client.refreshToken();
    expect(captured.url).toBe(`${CODEBUDDY_BASES.chatCN}/v2/plugin/auth/token/refresh`);
    expect(captured.init.headers["X-Refresh-Token"]).toBe("rt-1");
    expect(t.accessToken).toBe("at-2");
  });
});

describe("growth tasks", () => {
  it("normalises progress objects and derives claimable", () => {
    const tasks = parseGrowthTasks({
      tasks: [
        { task_code: "chat_5", reward_credit: 100, reward_energy: 5, progress: { current: 5, target: 5 }, accept_status: "accepted" },
        { task_code: "first_buddy", reward_credit: 300, current: 0, target: 1, accept_status: "claimed" },
      ],
    });
    expect(tasks[0]).toMatchObject({ taskCode: "chat_5", current: 5, target: 5, credit: 100, energy: 5, claimable: true, claimed: false });
    expect(tasks[1]).toMatchObject({ taskCode: "first_buddy", claimable: false, claimed: true });
  });

  it("accept posts task_codes and claim uses the web-domain path", async () => {
    const calls = [];
    const client = makeClient(vi.fn(async (url, init) => { calls.push({ url, init }); return ok({ already_claimed: false, credit: 10, energy: 1 }); }));
    await acceptTasks(client, ["chat_5"]);
    expect(calls[0].url).toContain("/v2/activity/growth/tasks/accept");
    expect(JSON.parse(calls[0].init.body)).toEqual({ task_codes: ["chat_5"] });

    const res = await claimReward(client, "chat_5");
    expect(calls[1].url).toBe(`${CODEBUDDY_BASES.webCN}/activity/growth/tasks/chat_5/claim`);
    expect(res).toEqual({ alreadyClaimed: false, credit: 10, energy: 1 });
  });

  it("mp claim falls back to the web domain on 400", async () => {
    const calls = [];
    const client = makeClient(vi.fn(async (url, init) => {
      calls.push(url);
      if (url.startsWith(CODEBUDDY_BASES.chatCN)) return jsonResponse({ msg: "task not completed" }, 400);
      return ok({ already_claimed: true, credit: 0, energy: 0 });
    }));
    const res = await claimRewardMP(client, "school_season");
    expect(calls[0]).toContain(`${CODEBUDDY_BASES.chatCN}/activity/growth/tasks/school_season/claim`);
    expect(calls[1]).toContain(`${CODEBUDDY_BASES.webCN}/activity`);
    expect(res.alreadyClaimed).toBe(true);
  });
});

describe("travel + streak", () => {
  it("parses travel status fields", async () => {
    const client = makeClient(vi.fn(async () => ok({ state: "arrived", daily_limit_reached: false, record_id: 9, reward_credit: 20 })));
    expect(await travelStatus(client)).toEqual({ state: "arrived", dailyLimitReached: false, recordId: 9, rewardCredit: 20 });
  });

  it("buddyFirst reports a skip on the 400 threshold error", async () => {
    const client = makeClient(vi.fn(async () => jsonResponse({ msg: "first_buddy task not completed yet" }, 400)));
    const res = await buddyFirst(client);
    expect(res).toEqual({ ok: false, skipped: "task_incomplete" });
  });

  it("growthStreak reads data.streak.days", async () => {
    const client = makeClient(vi.fn(async () => ok({ streak: { days: 7 } })));
    expect(await growthStreak(client)).toBe(7);
  });

  it("redeemTier treats 403 as locked", async () => {
    const client = makeClient(vi.fn(async () => jsonResponse({ msg: "连续登录天数不足" }, 403)));
    expect(await redeemTier(client, "7d")).toEqual({ ok: false, locked: true });
  });

  it("lotteryChances parses chances", async () => {
    const client = makeClient(vi.fn(async () => ok({ chances: 3, module: { enabled: true } })));
    expect(await lotteryChances(client)).toEqual({ chances: 3, enabled: true });
  });
});

describe("codebuddy scheduler", () => {
  it("counts checkin ok/already/failed and skips global accounts", async () => {
    const mk = (behaviour) => ({ dailyCheckin: behaviour, fetchBalance: async () => ({}), isGlobal: false });
    const clients = [
      mk(async () => {}),
      mk(async () => { throw new CodeBuddyError(CB_ERROR_KIND.CLIENT, 200, "今天已签到"); }),
      mk(async () => { throw new Error("boom"); }),
      { ...mk(async () => {}), isGlobal: true },
    ];
    const res = await runCheckinAll(clients, { log: () => {} });
    expect(res.ok).toBe(1);
    expect(res.already).toBe(1);
    expect(res.failed).toBe(1);
  });

  it("flags a suspicious activity report when streak stays 0", async () => {
    const logs = [];
    let call = 0;
    const client = {
      isGlobal: false,
      reportChatActivity: async () => {},
      // growthStreak → GET /activity/growth/streak
    };
    const res = await runActivityAll([client], { log: (m) => logs.push(m), accountDelayMs: 0 });
    // No growthJSON on this stub → streak check throws → suspicious
    expect(res.ok).toBe(1);
    expect(res.suspicious).toBe(1);
    void call;
    expect(logs.some((l) => l.includes("streak check failed"))).toBe(true);
  });

  it("keepalive collects refreshed tokens only for accounts with a refreshToken", async () => {
    const good = { credential: { uid: "u1", refreshToken: "r" }, refreshToken: async () => ({ accessToken: "new" }) };
    const bad = { credential: { uid: "u2" }, refreshToken: async () => ({ accessToken: "x" }) };
    const res = await runKeepaliveAll([good, bad], { log: () => {} });
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({ uid: "u1", tokens: { accessToken: "new" } });
  });
});

describe("codebuddy helpers", () => {
  it("isBuddyTaskIncomplete requires a 400 + marker", () => {
    expect(isBuddyTaskIncomplete(new CodeBuddyError(CB_ERROR_KIND.CLIENT, 400, "FIRST_BUDDY task not completed yet"))).toBe(true);
    expect(isBuddyTaskIncomplete(new CodeBuddyError(CB_ERROR_KIND.CLIENT, 500, "first_buddy task not completed yet"))).toBe(false);
  });

  it("registers the 17 auto-completable growth tasks with runnable functions", async () => {
    const mod = await import("../../open-sse/codebuddy/upstream/desktop.js");
    expect(Array.isArray(mod.AUTO_TASK_CODES)).toBe(true);
    expect(mod.AUTO_TASK_CODES).toHaveLength(17);
    for (const code of mod.AUTO_TASK_CODES) {
      expect(typeof mod.DESKTOP_TASK_RUNNERS[code]).toBe("function");
    }
    expect(mod.AUTO_TASK_CODES).toContain("first_buddy");
    expect(mod.AUTO_TASK_CODES).toContain("Model_chat_GLM5.2");
    expect(mod.AUTO_TASK_CODES).not.toContain("Expert_Philanthropy"); // 需真实捐款，不可自动
  });

  it("ships the miniprogram (school) module with its runners", async () => {
    const mod = await import("../../open-sse/codebuddy/upstream/school.js");
    expect(typeof mod.reportMPEvent).toBe("function");
    expect(typeof mod.runSchoolSeason).toBe("function");
  });
});