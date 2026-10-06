// 模块导出面守卫：跨模块 named import 写错时，webpack 只给 warning、vitest 也常常
// 静默成 undefined —— 于是功能在运行时才炸。这里显式断言关键导出存在。
// （v0.8.1：build 曾报 growthStreakFull / resolveClaimConfig 导入错误，本测试防回归。）
import { describe, it, expect } from "vitest";

describe("zcode claim 模块导出面", () => {
  it("config.js exports resolveClaimConfig", async () => {
    const m = await import("../../open-sse/claim/config.js");
    expect(typeof m.resolveClaimConfig).toBe("function");
  });

  it("service.js exports the scheduler/gateway factories", async () => {
    const m = await import("../../open-sse/claim/service.js");
    expect(typeof m.createClaimGateway).toBe("function");
    expect(typeof m.createClaimScheduler).toBe("function");
    expect(typeof m.claimPlatform).toBe("function");
  });

  it("client.js exports ClaimPreviewError + createClaimClient", async () => {
    const m = await import("../../open-sse/claim/client.js");
    expect(typeof m.createClaimClient).toBe("function");
    expect(typeof m.ClaimPreviewError).toBe("function");
  });
});

describe("codebuddy 模块导出面", () => {
  it("travel.js owns growthStreak/growthStreakFull", async () => {
    const m = await import("../../open-sse/codebuddy/upstream/travel.js");
    expect(typeof m.growthStreak).toBe("function");
    expect(typeof m.growthStreakFull).toBe("function");
    expect(typeof m.travelStatus).toBe("function");
    expect(typeof m.buddyFirst).toBe("function");
  });

  it("streak.js owns redemption + lottery", async () => {
    const m = await import("../../open-sse/codebuddy/upstream/streak.js");
    expect(typeof m.runStreakLoop).toBe("function");
    expect(typeof m.redeemTier).toBe("function");
    expect(typeof m.lotteryChances).toBe("function");
    expect(typeof m.lotteryDraw).toBe("function");
  });

  it("scheduler.js exports the task flows", async () => {
    const m = await import("../../open-sse/codebuddy/scheduler.js");
    for (const fn of ["runCheckinAll", "runActivityAll", "runTravelAll", "runKeepaliveAll", "runStreakBonusAll"]) {
      expect(typeof m[fn]).toBe("function");
    }
  });

  it("client.js exports the upstream primitives used by the flows", async () => {
    const m = await import("../../open-sse/codebuddy/upstream/client.js");
    for (const fn of ["createCodeBuddyClient", "isAlreadyCheckin", "isBuddyTaskIncomplete", "clientToken", "deriveAccountStableId"]) {
      expect(typeof m[fn]).toBe("function");
    }
  });

  it("orchestrator.js exports the one-click entrypoints", async () => {
    const m = await import("../../open-sse/codebuddy/orchestrator.js");
    expect(typeof m.completeAllTasks).toBe("function");
    expect(typeof m.listAutomationStatus).toBe("function");
  });
});

describe("codebuddy 连登闭环（回归：scheduler 引错模块会静默空跑）", () => {
  it("runStreakBonusAll actually redeems + draws through growthJSON", async () => {
    const calls = [];
    const client = {
      isGlobal: false,
      credential: { uid: "u1" },
      // 连登状态：7d 未兑换、14d 已兑换、28d 未解锁；抽奖 1 次
      growthJSON: async (method, path) => {
        calls.push(path);
        if (path.endsWith("/activity/growth/streak")) {
          return {
            streak: { days: 8 },
            redemption_status: { tier_7d_status: "locked", tier_14d_status: "redeemed", tier_28d_status: "locked" },
          };
        }
        if (path.endsWith("/activity/growth/redeem")) return {};
        if (path.endsWith("/activity/growth/lottery/summary")) return { chances: 1, module: { enabled: true } };
        if (path.endsWith("/activity/growth/lottery/draw")) return { prize: "credits" };
        return {};
      },
    };
    const { runStreakBonusAll } = await import("../../open-sse/codebuddy/scheduler.js");
    const summary = await runStreakBonusAll([client], { log: () => {} });

    expect(calls).toContain("/activity/growth/streak");
    expect(calls).toContain("/activity/growth/redeem");
    expect(calls).toContain("/activity/growth/lottery/summary");
    expect(calls).toContain("/activity/growth/lottery/draw");
    expect(summary.u1.drawn).toBe(1);
  });
});