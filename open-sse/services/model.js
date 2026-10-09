import REGISTRY from "../providers/registry/index.js";

// Alias→id derived from registry single-source: id→id, alias→id, aliases[]→id.
// Media-only providers without a registry transport entry keep explicit aliases here.
const MEDIA_ONLY_ALIASES = {
  el: "elevenlabs",
  jina: "jina-ai",
  "jina-ai": "jina-ai",
  polly: "aws-polly",
  "aws-polly": "aws-polly",
};

const ALIAS_TO_PROVIDER_ID = { ...MEDIA_ONLY_ALIASES };
for (const entry of REGISTRY) {
  ALIAS_TO_PROVIDER_ID[entry.id] = entry.id;
  if (entry.alias) ALIAS_TO_PROVIDER_ID[entry.alias] = entry.id;
  for (const a of entry.aliases || []) ALIAS_TO_PROVIDER_ID[a] = entry.id;
}

const BUILTIN_MODEL_ALIASES = {
  "grok-build": "gcli/grok-build",
  // v0.8.8 — Qoder 的 Qwen 系模型在注册表里用的是代号（qmodel / qfmodel …），
  // 真实 Qwen 名没人登记，裸调会落到没有连接的提供商而失败。这里按显示名做映射，
  // 让真实 Qwen 名可以直接调用（用户别名优先级更高，可自行覆盖）。
  "qwen3.8-max": "qoder-cn/qmodel_38max", // Qwen3.8-Max
  "qwen3.7-max": "qoder-cn/qmodel_latest", // Qwen3.7-Max
  "qwen3.7-plus": "qoder-cn/qmodel", // Qwen3.7-Plus
  "qwen3.8-flash": "qoder-cn/qfmodel", // Qwen3.8-Flash
};

// modelId → 注册表里发布它的条目（单一数据源，用于裸名兜底解析）
const MODEL_PROVIDER_INDEX = new Map();
// v0.8.9 — 友好名 → 发布它的条目（只收 modelAliases 里的友好名，用于裸名兜底；精确 id 优先）
const MODEL_FRIENDLY_INDEX = new Map();
const pushIndex = (index, key, entry) => {
  const list = index.get(key);
  if (list) list.push(entry);
  else index.set(key, [entry]);
};
// v0.8.9 — 提供商作用域的「上游代号 ⇄ 友好名」映射（注册表 opt-in 字段 modelAliases）。
// Qoder 的模型 id 是上游契约（执行器按该 key 查 model_config），不能改 id；但代号对用户不可读。
// 于是列表/白名单展示友好名、调用也接受友好名，且仅在该提供商前缀下生效，裸名行为不变。
// 这样 providers 之间不会互相串味：qdcn/glm-5.3 命中 Qoder，裸 glm-5.3 仍归 CodeBuddy。
const PROVIDER_FRIENDLY_TO_ID = new Map(); // providerId → Map(lower(友好名) → 代号)
const PROVIDER_ID_TO_FRIENDLY = new Map(); // providerId → Map(代号 → lower(友好名))

for (const entry of REGISTRY) {
  for (const m of entry.models || []) {
    if (m?.id) pushIndex(MODEL_PROVIDER_INDEX, m.id, entry);
  }
  const aliases = entry.modelAliases;
  if (!aliases) continue;
  const toId = new Map();
  const toFriendly = new Map();
  for (const [id, friendly] of Object.entries(aliases)) {
    if (!id || !friendly) continue;
    const key = String(friendly).toLowerCase();
    toId.set(key, id);
    toFriendly.set(id, key);
    pushIndex(MODEL_FRIENDLY_INDEX, key, entry);
  }
  if (toId.size) {
    PROVIDER_FRIENDLY_TO_ID.set(entry.id, toId);
    PROVIDER_ID_TO_FRIENDLY.set(entry.id, toFriendly);
  }
}

/**
 * v0.8.9 友好名 → 上游代号（仅在该提供商作用域内匹配，未命中原样返回）。
 * 调用 `qdcn/qwen3.8-flash` 时把 model 段归一化成上游契约用的代号 `qfmodel`。
 */
export function resolveProviderModelAlias(provider, model) {
  if (!provider || !model) return model;
  const map = PROVIDER_FRIENDLY_TO_ID.get(provider);
  return map?.get(String(model).toLowerCase()) || model;
}

/**
 * v0.8.9 上游代号 → 友好名（用于列表展示，隐去代号；未命中原样返回）。
 */
export function providerModelDisplayName(provider, model) {
  if (!provider || !model) return model;
  const map = PROVIDER_ID_TO_FRIENDLY.get(provider);
  return map?.get(model) || model;
}

// 只把「对话类」提供商作为兜底候选：显式声明了 serviceKinds 且不含 llm 的（tts/stt/image 等）
// 一律排除；未声明 serviceKinds 的视为对话网关（如 codebuddy-cn / deepseek）。
function isChatCapableEntry(entry) {
  return !entry.serviceKinds || entry.serviceKinds.includes("llm");
}

/**
 * v0.8.6 裸模型名的「按连接兜底」。
 *
 * 背景：裸名（如 deepseek-v4.1-flash）先经前缀规则推断（`/^deepseek-/ → openrouter`），
 * 若用户没有该提供商的连接，请求会以 404「No active credentials for provider」失败，
 * 只能写死前缀（cbcn/xxx）才可用。
 *
 * 规则：仅当【推断出的 provider 没有活跃连接】时，改选「注册表确实发布该模型、且用户有
 * 活跃连接」的 provider（按 registry priority 升序）。推断结果可用时原样返回，不动。
 * 无候选返回 null，由调用方保持原结果（不改变既有失败语义）。
 *
 * 纯函数（只依赖注册表 + 传入的连接集合），便于单测。
 */
export function resolveModelProviderFallback({ provider, model, activeProviderIds }) {
  if (!provider || !model || !activeProviderIds?.size) return null;
  if (activeProviderIds.has(provider)) return null; // 推断结果可用 → 不动
  const pick = (index, key) =>
    (index.get(key) || [])
      .filter((e) => isChatCapableEntry(e) && activeProviderIds.has(e.id))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999))[0]?.id || null;
  // v0.8.9：先按「精确 id」命中，再退到「友好名」。精确优先可保证友好名不会抢走其它
  // 提供商发布的同 id 模型（例：裸 `glm-5.3` 仍归 codebuddy，裸 `kimi-k3`（仅 Qoder 有）归 qoder-cn）。
  return pick(MODEL_PROVIDER_INDEX, model) || pick(MODEL_FRIENDLY_INDEX, String(model).toLowerCase());
}

/**
 * v0.8.6 带命名空间的模型 id 兜底（如 NVIDIA 的 `z-ai/glm-5.2`、`deepseek-ai/deepseek-v4-pro`）。
 *
 * 这类 id 本身就含 `/`，会被 parseModel 拆成「provider=z-ai, model=glm-5.2」，而 `z-ai`
 * 并不是注册的提供商 → 请求落到不存在的提供商上失败。正确写法是 `nvidia/z-ai/glm-5.2`，
 * 但用户很容易漏掉前缀。
 *
 * 规则（三重保险，避免抢走真正的显式前缀）：
 *   1. 首段是已注册的提供商 id/别名 → 不动（尊重显式前缀）
 *   2. 首段是「有活跃连接的提供商」→ 不动（同上）
 *   3. 整串作为模型 id 命中「确实发布它且有连接的提供商」→ 用它，且上游模型名保持整串
 */
export function resolveNamespacedModelFallback({ modelStr, activeProviderIds }) {
  if (typeof modelStr !== "string" || !activeProviderIds?.size) return null;
  const slash = modelStr.indexOf("/");
  if (slash <= 0 || slash === modelStr.length - 1) return null;
  const head = modelStr.slice(0, slash);
  if (ALIAS_TO_PROVIDER_ID[head]) return null; // 已知提供商/别名 → 尊重显式前缀
  if (activeProviderIds.has(head)) return null; // 有连接的提供商前缀 → 尊重
  const candidates = (MODEL_PROVIDER_INDEX.get(modelStr) || [])
    .filter((e) => isChatCapableEntry(e) && activeProviderIds.has(e.id))
    .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return candidates[0]?.id || null;
}

/**
 * Resolve provider alias to provider ID
 */
export function resolveProviderAlias(aliasOrId) {
  return ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
}

/**
 * Parse model string: "alias/model" or "provider/model" or just alias
 */
export function parseModel(modelStr) {
  if (!modelStr) {
    return { provider: null, model: null, isAlias: false, providerAlias: null };
  }

  // Check if standard format: provider/model or alias/model
  if (modelStr.includes("/")) {
    const firstSlash = modelStr.indexOf("/");
    const providerOrAlias = modelStr.slice(0, firstSlash);
    const model = modelStr.slice(firstSlash + 1);
    const provider = resolveProviderAlias(providerOrAlias);
    return { provider, model, isAlias: false, providerAlias: providerOrAlias };
  }

  // Alias format (model alias, not provider alias)
  return {
    provider: null,
    model: modelStr,
    isAlias: true,
    providerAlias: null,
  };
}

/**
 * Resolve model alias from aliases object
 * Format: { "alias": "provider/model" }
 */
export function resolveModelAliasFromMap(alias, aliases) {
  if (!aliases) return null;

  // Check if alias exists
  const resolved = aliases[alias];
  if (!resolved) return null;

  // Resolved value is "provider/model" format
  if (typeof resolved === "string" && resolved.includes("/")) {
    const firstSlash = resolved.indexOf("/");
    const providerOrAlias = resolved.slice(0, firstSlash);
    return {
      provider: resolveProviderAlias(providerOrAlias),
      model: resolved.slice(firstSlash + 1),
    };
  }

  // Or object { provider, model }
  if (typeof resolved === "object" && resolved.provider && resolved.model) {
    return {
      provider: resolveProviderAlias(resolved.provider),
      model: resolved.model,
    };
  }

  return null;
}

/**
 * Get full model info (parse or resolve)
 * @param {string} modelStr - Model string
 * @param {object|function} aliasesOrGetter - Aliases object or async function to get aliases
 */
export async function getModelInfoCore(modelStr, aliasesOrGetter) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  // Get aliases (from object or function)
  const aliases =
    typeof aliasesOrGetter === "function"
      ? await aliasesOrGetter()
      : aliasesOrGetter;

  // Resolve alias
  const resolved =
    resolveModelAliasFromMap(parsed.model, aliases) ||
    resolveModelAliasFromMap(parsed.model, BUILTIN_MODEL_ALIASES);
  if (resolved) {
    return resolved;
  }

  // Fallback: infer provider from model name prefix
  return {
    provider: inferProviderFromModelName(parsed.model),
    model: parsed.model,
  };
}

// Config-driven prefix → provider inference (first match wins, fallback "openai").
const MODEL_PREFIX_PROVIDERS = [
  // Codex CLI sends this bare virtual model for auto-review - keep it on OAuth Codex (#1398).
  [/^codex-auto-review$/, "codex"],
  // Codex-only GPT model slugs: present in backend-api/codex/models but not on the
  // OpenAI API.  Without these rules a bare model id (e.g. "gpt-5.6-terra" from the
  // Codex CLI /model picker) resolves to provider "openai", which 404s for users that
  // only have a Codex OAuth account and no OpenAI API key (#4405).
  // Ranges covered: gpt-5.x, gpt-6.x, gpt-daybreak-*, gpt-reserve* — all are
  // Codex-backend models.  Plain "gpt-4*" / "gpt-3.5*" / "gpt-4o*" fall through to
  // the generic gpt-* → openai rule below.
  [/^gpt-[56]\./, "codex"],
  [/^gpt-6-/, "codex"],
  [/^gpt-daybreak-/, "codex"],
  [/^gpt-reserve/, "codex"],
  [/^claude-/, "anthropic"],
  // Bedrock inference profile IDs: us.anthropic.*, global.anthropic.*, eu.anthropic.*, etc.
  // Claude Code stores the Bedrock model ID directly (e.g. us.anthropic.claude-sonnet-4-6),
  // so bare usage without a provider/ prefix must route to bedrock, not fall through to openai.
  [/^(us|eu|ap|global)\.(anthropic|meta|amazon|mistral|xai)\./, "bedrock"],
  [/^gemini-/, "gemini"],
  [/^gpt-/, "openai"],
  [/^o[134]/, "openai"],
  [/^deepseek-/, "openrouter"],
];

/**
 * Infer provider from model name prefix
 * Used as fallback when no provider prefix or alias is given
 */
function inferProviderFromModelName(modelName) {
  if (!modelName) return "openai";
  const m = modelName.toLowerCase();
  return MODEL_PREFIX_PROVIDERS.find(([re]) => re.test(m))?.[1] || "openai";
}
