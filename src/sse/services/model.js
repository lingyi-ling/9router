// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getProviderConnections } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore, resolveModelProviderFallback, resolveNamespacedModelFallback } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// v0.8.6 裸名兜底用的「有活跃连接的提供商」集合，短 TTL 缓存：
// 裸名请求很多，不能每次都全表查 providerConnections。
const ACTIVE_PROVIDERS_TTL_MS = 5000;
let activeProvidersCache = { at: 0, ids: new Set() };

async function getActiveProviderIdSet() {
  const now = Date.now();
  if (now - activeProvidersCache.at < ACTIVE_PROVIDERS_TTL_MS) return activeProvidersCache.ids;
  let ids = new Set();
  try {
    const conns = await getProviderConnections({ isActive: true });
    ids = new Set(conns.map((c) => c.provider));
  } catch {
    // 读库失败按「无连接」处理 → 兜底不生效，保持原有失败语义（fail-safe）
    ids = new Set();
  }
  activeProvidersCache = { at: now, ids };
  return ids;
}

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
for (const entry of REGISTRY) {
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
      const matchedOpenAI = openaiNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedOpenAI) {
        return { provider: matchedOpenAI.id, model: parsed.model };
      }

      const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
      const matchedAnthropic = anthropicNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedAnthropic) {
        return { provider: matchedAnthropic.id, model: parsed.model };
      }

      const embeddingNodes = await getProviderNodes({ type: "custom-embedding" });
      const matchedEmbedding = embeddingNodes.find((node) => node.prefix === parsed.providerAlias);
      if (matchedEmbedding) {
        return { provider: matchedEmbedding.id, model: parsed.model };
      }
    }
    // v0.8.6 命名空间模型兜底：`z-ai/glm-5.2` 这类首段不是真实提供商的 id，整串命中
    // 「有连接的提供商发布的模型」时改走该提供商（上游模型名保持整串）。
    const nsProvider = resolveNamespacedModelFallback({
      modelStr,
      activeProviderIds: await getActiveProviderIdSet(),
    });
    if (nsProvider) return { provider: nsProvider, model: modelStr };
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  const info = await getModelInfoCore(modelStr, getModelAliases);

  // v0.8.6 裸名兜底：推断出的 provider 没有活跃连接时，改选「确实发布该模型且有连接」的
  // provider。只作用于裸名（带前缀 / combo / provider-node 的路径在前面已各自返回）。
  const fallbackProvider = resolveModelProviderFallback({
    provider: info.provider,
    model: info.model,
    activeProviderIds: await getActiveProviderIdSet(),
  });
  return fallbackProvider ? { provider: fallbackProvider, model: info.model } : info;
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
