// 模块导出面守卫：跨模块 named import 写错时，webpack 只给 warning、vitest 也常常
// 静默成 undefined —— 于是功能在运行时才炸。这里显式断言关键导出存在。
// （v0.8.1：build 曾报 growthStreakFull / resolveClaimConfig 导入错误，本测试防回归。）
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

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

describe("codebuddy 本机凭证扫描（v0.8.2）", () => {
  it("localCredentials.js 导出扫描/导入/能力自检", async () => {
    const m = await import("../../open-sse/codebuddy/localCredentials.js");
    expect(typeof m.scanLocalCredentials).toBe("function");
    expect(typeof m.readCredentialForImport).toBe("function");
    expect(typeof m.localCredentialScanCapability).toBe("function");
    expect(typeof m.readBuildKeyPayload).toBe("function");
  });

  it("未安装客户端时扫描优雅降级（不抛异常，返回数组）", async () => {
    const { scanLocalCredentials, localCredentialScanCapability } = await import(
      "../../open-sse/codebuddy/localCredentials.js"
    );
    const items = scanLocalCredentials();
    expect(Array.isArray(items)).toBe(true);
    // 能力自检必须稳定返回平台与待扫描目录清单
    const cap = localCredentialScanCapability();
    expect(typeof cap.platform).toBe("string");
    expect(Array.isArray(cap.authDirs)).toBe(true);
  });
});

describe("ZCode-register 产物解析与解密（v0.8.3）", () => {
  // 与官方 credentialCipher 同款：AES-256-GCM，key=sha256(secret)，固定 IV 便于断言
  const SECRET = "unit-test-secret";
  const enc = (plain) => {
    const key = crypto.createHash("sha256").update(SECRET).digest();
    const iv = Buffer.alloc(12, 7);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `enc:v1:${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
  };
  const env = { ZCODE_CREDENTIAL_SECRET: SECRET };

  it("parseRegisterSuccessText 解析四段式行", async () => {
    const { parseRegisterSuccessText } = await import("../../open-sse/zcode/registerArtifacts.js");
    const creds = { "zcodejwttoken": enc("jwt-abc") };
    const line = `a@b.com----pw123----${JSON.stringify(creds)}----{"k":1}`;
    const items = parseRegisterSuccessText(line);
    expect(items).toHaveLength(1);
    expect(items[0].email).toBe("a@b.com");
    expect(items[0].password).toBe("pw123");
    expect(items[0].credentials.zcodejwttoken).toBe(creds.zcodejwttoken);
    expect(items[0].error).toBe("");
  });

  it("格式不符的行给出 error 且不抛", async () => {
    const { parseRegisterSuccessText } = await import("../../open-sse/zcode/registerArtifacts.js");
    const items = parseRegisterSuccessText("not-a-valid-line");
    expect(items).toHaveLength(1);
    expect(items[0].error).toMatch(/格式不符/);
  });

  it("extractZcodeAccount 解密并提取 planKey/jwt/用户信息（zai → glm）", async () => {
    const { extractZcodeAccount } = await import("../../open-sse/zcode/registerArtifacts.js");
    const credentials = {
      "oauth:zai:access_token": enc("oauth-access"),
      "zcodejwttoken": enc("jwt-token-xyz"),
      "oauth:zai:user_info": enc(JSON.stringify({ user_id: "u-1", email: "u@x.com", name: "None" })),
      "oauth:active_provider": enc("zai"),
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:u-1:api-key": enc("akid.secret"),
      "account-provider:coding-plan:account:zai-team-coding-plan:account:u-1:api-key": enc("team.secret"),
    };
    const acct = extractZcodeAccount(credentials, env);
    expect(acct.planKey).toBe("akid.secret"); // 个人套餐优先
    expect(acct.jwt).toBe("jwt-token-xyz");
    expect(acct.email).toBe("u@x.com");
    expect(acct.userId).toBe("u-1");
    expect(acct.name).toBe(""); // "None" 视为空
    expect(acct.provider).toBe("glm");
    expect(acct.realm).toBe("intl");
  });

  it("extractZcodeAccount 识别 bigmodel → glm-cn，且兼容明文值", async () => {
    const { extractZcodeAccount } = await import("../../open-sse/zcode/registerArtifacts.js");
    const credentials = {
      "zcodejwttoken": "plain-jwt",
      "oauth:active_provider": "bigmodel",
      "account-provider:coding-plan:account:bigmodel-coding-plan:account:u-2:api-key": "plain.plan",
    };
    const acct = extractZcodeAccount(credentials, env);
    expect(acct.jwt).toBe("plain-jwt");
    expect(acct.planKey).toBe("plain.plan");
    expect(acct.provider).toBe("glm-cn");
    expect(acct.realm).toBe("cn");
  });
});