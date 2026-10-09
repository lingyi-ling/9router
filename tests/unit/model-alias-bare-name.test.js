// 回归：裸「真实模型名」调用的路由。
// 背景（v0.8.5）：CodeBuddy 是统一网关，deepseek-* 裸名会被前缀规则推成 openrouter，
// 用户没有 openrouter 连接时调用直接失败，只能写 cbcn/ 前缀。
import { describe, it, expect } from "vitest";
import { getModelInfoCore, parseModel } from "../../open-sse/services/model.js";

describe("裸模型名解析（getModelInfoCore）", () => {
  it("CodeBuddy 真实模型名直接解析到 codebuddy-cn", async () => {
    const info = await getModelInfoCore("deepseek-v4.1-flash");
    expect(info.provider).toBe("codebuddy-cn");
    expect(info.model).toBe("deepseek-v4.1-flash");
  });

  it("deepseek-v4-pro 同样落到 codebuddy-cn", async () => {
    const info = await getModelInfoCore("deepseek-v4-pro");
    expect(info.provider).toBe("codebuddy-cn");
  });

  it("带前缀写法不受影响", async () => {
    const info = await getModelInfoCore("cbcn/deepseek-v4.1-flash");
    expect(info.provider).toBe("codebuddy-cn");
    expect(info.model).toBe("deepseek-v4.1-flash");
  });

  it("其它 deepseek-* 名仍走原前缀推断（openrouter），未被误伤", async () => {
    const info = await getModelInfoCore("deepseek-chat");
    expect(info.provider).toBe("openrouter");
  });

  it("用户别名优先级高于内置别名", async () => {
    const info = await getModelInfoCore("deepseek-v4.1-flash", {
      "deepseek-v4.1-flash": "codebuddy-intl/deepseek-v4.1-flash",
    });
    expect(info.provider).toBe("codebuddy-intl");
  });
});

describe("parseModel 基础行为", () => {
  it("provider/model 形式按 provider 解析", () => {
    const parsed = parseModel("codebuddy-cn/glm-5.2");
    expect(parsed.provider).toBe("codebuddy-cn");
    expect(parsed.model).toBe("glm-5.2");
  });
});
