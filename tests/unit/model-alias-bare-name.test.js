// 回归：裸「真实模型名」的路由。
//
// v0.8.6 之前：裸名只经前缀规则推断（deepseek-* → openrouter、其余 → openai），
// 用户没有该提供商连接时直接 404「No active credentials for provider」。
// 现在由 resolveModelProviderFallback 按「注册表发布该模型 + 有活跃连接」兜底。
import { describe, it, expect } from "vitest";
import { getModelInfoCore, parseModel, resolveModelProviderFallback, resolveNamespacedModelFallback, resolveProviderModelAlias, providerModelDisplayName } from "../../open-sse/services/model.js";

describe("resolveModelProviderFallback（裸名按连接兜底）", () => {
  const active = (...ids) => new Set(ids);

  it("推断到没有连接的 provider 时，改选确实发布该模型且有连接的 provider", () => {
    const got = resolveModelProviderFallback({
      provider: "openrouter", // deepseek-* 的前缀推断结果
      model: "deepseek-v4.1-flash",
      activeProviderIds: active("codebuddy-cn", "glm"),
    });
    expect(got).toBe("codebuddy-cn");
  });

  it("推断结果本身可用时不动（null = 保持原样）", () => {
    const got = resolveModelProviderFallback({
      provider: "openrouter",
      model: "deepseek-v4.1-flash",
      activeProviderIds: active("openrouter"),
    });
    expect(got).toBeNull();
  });

  it("多个候选时按 registry priority 升序（codebuddy-cn 90 < glm 140）", () => {
    const got = resolveModelProviderFallback({
      provider: "openai", // glm-5.2 的前缀推断结果（无连接）
      model: "glm-5.2",
      activeProviderIds: active("glm", "codebuddy-cn"),
    });
    expect(got).toBe("codebuddy-cn");
  });

  it("没有任何有连接的提供商发布该模型时返回 null（不改变原失败语义）", () => {
    const got = resolveModelProviderFallback({
      provider: "openrouter",
      model: "deepseek-chat", // 仅 deepseek 发布，用户没连
      activeProviderIds: active("codebuddy-cn"),
    });
    expect(got).toBeNull();
  });

  it("排除非对话类提供商（tts/stt/image 不参与兜底）", () => {
    const got = resolveModelProviderFallback({
      provider: "openai",
      model: "flux-pro-1.1", // 仅 black-forest-labs(image) 发布
      activeProviderIds: active("black-forest-labs"),
    });
    expect(got).toBeNull();
  });

  it("空连接集合时不动", () => {
    expect(
      resolveModelProviderFallback({ provider: "openrouter", model: "deepseek-v4.1-flash", activeProviderIds: active() })
    ).toBeNull();
  });
});

describe("resolveNamespacedModelFallback（带命名空间的 id，如 NVIDIA）", () => {
  const active = (...ids) => new Set(ids);

  it("首段不是真实提供商时，整串命中已连接提供商的模型 → 用它", () => {
    expect(
      resolveNamespacedModelFallback({ modelStr: "z-ai/glm-5.2", activeProviderIds: active("nvidia") })
    ).toBe("nvidia");
  });

  it("首段是已注册提供商 → 不动（尊重显式前缀）", () => {
    expect(
      resolveNamespacedModelFallback({ modelStr: "glm/glm-5.2", activeProviderIds: active("nvidia") })
    ).toBeNull();
  });

  it("首段是有连接的提供商 → 不动", () => {
    expect(
      resolveNamespacedModelFallback({ modelStr: "nvidia/z-ai/glm-5.2", activeProviderIds: active("nvidia") })
    ).toBeNull();
  });

  it("整串不是任何已连接提供商的模型 → 不动", () => {
    expect(
      resolveNamespacedModelFallback({ modelStr: "z-ai/not-a-model", activeProviderIds: active("nvidia") })
    ).toBeNull();
  });

  it("没有斜杠 / 边界情况 → 不动", () => {
    expect(resolveNamespacedModelFallback({ modelStr: "glm-5.2", activeProviderIds: active("nvidia") })).toBeNull();
    expect(resolveNamespacedModelFallback({ modelStr: "z-ai/", activeProviderIds: active("nvidia") })).toBeNull();
    expect(resolveNamespacedModelFallback({ modelStr: "/glm-5.2", activeProviderIds: active("nvidia") })).toBeNull();
  });
});

describe("Qoder Qwen 真实名映射（v0.8.8）", () => {
  it("真实 Qwen 名 → qoder-cn 的代号", async () => {
    const cases = [
      ["qwen3.8-max", "qoder-cn", "qmodel_38max"],
      ["qwen3.7-max", "qoder-cn", "qmodel_latest"],
      ["qwen3.7-plus", "qoder-cn", "qmodel"],
      ["qwen3.8-flash", "qoder-cn", "qfmodel"],
    ];
    for (const [alias, provider, model] of cases) {
      const info = await getModelInfoCore(alias);
      expect([alias, info.provider, info.model]).toEqual([alias, provider, model]);
    }
  });
});

describe("getModelInfoCore 既有行为未被改变", () => {
  it("裸 deepseek-* 仍按前缀规则推断为 openrouter（兜底由应用层做）", async () => {
    const info = await getModelInfoCore("deepseek-v4.1-flash");
    expect(info.provider).toBe("openrouter");
    expect(info.model).toBe("deepseek-v4.1-flash");
  });

  it("带前缀写法按 provider 解析，不受兜底影响", async () => {
    const info = await getModelInfoCore("cbcn/deepseek-v4.1-flash");
    expect(info.provider).toBe("codebuddy-cn");
    expect(info.model).toBe("deepseek-v4.1-flash");
  });

  it("用户别名优先级最高", async () => {
    const info = await getModelInfoCore("deepseek-v4.1-flash", {
      "deepseek-v4.1-flash": "codebuddy-intl/deepseek-v4.1-flash",
    });
    expect(info.provider).toBe("codebuddy-intl");
  });

  it("其它 deepseek-* 未被误伤", async () => {
    const info = await getModelInfoCore("deepseek-chat");
    expect(info.provider).toBe("openrouter");
  });
});

describe("Qoder 提供商作用域的友好名映射（v0.8.9）", () => {
  it("友好名 → 上游代号（带前缀调用时归一化）", () => {
    const cases = [
      ["qwen3.8-max", "qmodel_38max"],
      ["qwen3.7-max", "qmodel_latest"],
      ["qwen3.7-plus", "qmodel"],
      ["qwen3.8-flash", "qfmodel"],
      ["kimi-k3", "kmodel_latest"],
      ["kimi-k2.7-code", "kmodel"],
      ["glm-5.3", "gmodel"],
      ["glm-5.3-flash", "gfmodel"],
      ["deepseek-v4-pro", "dmodel"],
      ["deepseek-v4-flash", "dfmodel"],
      ["minimax-m3", "mmodel"],
    ];
    for (const [friendly, code] of cases) {
      expect(resolveProviderModelAlias("qoder-cn", friendly)).toBe(code);
      expect(resolveProviderModelAlias("qoder", friendly)).toBe(code);
    }
  });

  it("代号本身原样返回（旧写法仍可用）", () => {
    expect(resolveProviderModelAlias("qoder-cn", "qfmodel")).toBe("qfmodel");
  });

  it("作用域之外不映射（不会把 codebuddy 的 glm-5.3 改掉）", () => {
    expect(resolveProviderModelAlias("codebuddy-cn", "glm-5.3")).toBe("glm-5.3");
    expect(resolveProviderModelAlias(null, "glm-5.3")).toBe("glm-5.3");
  });

  it("代号 → 友好名（列表展示隐去代号）", () => {
    expect(providerModelDisplayName("qoder-cn", "qfmodel")).toBe("qwen3.8-flash");
    expect(providerModelDisplayName("qoder-cn", "gmodel")).toBe("glm-5.3");
    expect(providerModelDisplayName("qoder-cn", "ultimate")).toBe("ultimate"); // 无映射原样
    expect(providerModelDisplayName("codebuddy-cn", "glm-5.3")).toBe("glm-5.3");
  });

  it("裸名兜底：优先精确 id，避免友好名抢走 CodeBuddy 的 glm-5.3", () => {
    // codebuddy-cn 与 qoder-cn 都「可用」时，裸 glm-5.3 归 codebuddy（精确 id）
    expect(
      resolveModelProviderFallback({
        provider: "openai",
        model: "glm-5.3",
        activeProviderIds: new Set(["codebuddy-cn", "qoder-cn"]),
      })
    ).toBe("codebuddy-cn");
  });

  it("裸名兜底：无精确命中时退到友好名（仅连了 qoder 时 kimi-k3 归 qoder-cn）", () => {
    expect(
      resolveModelProviderFallback({
        provider: "openai",
        model: "kimi-k3",
        activeProviderIds: new Set(["qoder-cn"]),
      })
    ).toBe("qoder-cn");
  });
});

describe("parseModel 基础行为", () => {
  it("provider/model 形式按 provider 解析", () => {
    const parsed = parseModel("codebuddy-cn/glm-5.2");
    expect(parsed.provider).toBe("codebuddy-cn");
    expect(parsed.model).toBe("glm-5.2");
  });
});
