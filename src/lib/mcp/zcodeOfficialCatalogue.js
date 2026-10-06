// Official ZCode plugin-MCP catalogue — ported from zcode-api
// src/mcp/official-catalogue.json (ZCode 3.14.3 marketplace snapshot,
// generated 2026-09-25). Regenerate from
// https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json when ZCode
// ships new plugins.
//
// Each entry maps a friendly `key` (the /mcp/{key} route name) to the official
// gateway route id (`/api/v1/mcp/server/{routeId}` on https://zcode.z.ai).
//
// v0.7.0 移植：本地静态目录，运行时绝不拉取 marketplace。
const DEFAULT_UPSTREAM_ORIGIN = "https://zcode.z.ai";

export const ZCODE_MCP_CATALOGUE = {
  generatedAt: "2026-09-25T15:20:02.957Z",
  marketplaceUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
  defaultUpstreamOrigin: DEFAULT_UPSTREAM_ORIGIN,
  servers: [
    {
      key: "finance-search",
      routeId: "finance_search",
      plugin: "finance-search",
      requiresPaidPlan: true,
      displayName: { en: "Financial Aggregated Search", "zh-CN": "金融聚合搜索" },
      description: {
        en: "MCP services for SEC EDGAR filing search and financial web and news search.",
        "zh-CN": "SEC EDGAR 文件检索与财经网页、新闻搜索 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "sec-search",
      routeId: "finance_sec_search",
      plugin: "finance-search",
      requiresPaidPlan: true,
      displayName: { en: "Financial Aggregated Search", "zh-CN": "金融聚合搜索" },
      description: {
        en: "MCP services for SEC EDGAR filing search and financial web and news search.",
        "zh-CN": "SEC EDGAR 文件检索与财经网页、新闻搜索 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "tianyancha",
      routeId: "finance_tianyancha",
      plugin: "tianyancha",
      requiresPaidPlan: true,
      displayName: { en: "Tianyancha", "zh-CN": "天眼查" },
      description: {
        en: "MCP service for Tianyancha company information queries.",
        "zh-CN": "天眼查企业信息查询 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "hexin-stock",
      routeId: "finance_hexin_stock",
      plugin: "hexin",
      requiresPaidPlan: true,
      displayName: { en: "RoyalFlush iFinD", "zh-CN": "同花顺" },
      description: {
        en: "MCP services for RoyalFlush iFinD stock, global stock, index, fund, and bond data.",
        "zh-CN": "同花顺股票、海外股票、指数、基金与债券数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "hexin-global-stock",
      routeId: "finance_hexin_global_stock",
      plugin: "hexin",
      requiresPaidPlan: true,
      displayName: { en: "RoyalFlush iFinD", "zh-CN": "同花顺" },
      description: {
        en: "MCP services for RoyalFlush iFinD stock, global stock, index, fund, and bond data.",
        "zh-CN": "同花顺股票、海外股票、指数、基金与债券数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "hexin-index",
      routeId: "finance_hexin_index",
      plugin: "hexin",
      requiresPaidPlan: true,
      displayName: { en: "RoyalFlush iFinD", "zh-CN": "同花顺" },
      description: {
        en: "MCP services for RoyalFlush iFinD stock, global stock, index, fund, and bond data.",
        "zh-CN": "同花顺股票、海外股票、指数、基金与债券数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "hexin-fund",
      routeId: "finance_hexin_fund",
      plugin: "hexin",
      requiresPaidPlan: true,
      displayName: { en: "RoyalFlush iFinD", "zh-CN": "同花顺" },
      description: {
        en: "MCP services for RoyalFlush iFinD stock, global stock, index, fund, and bond data.",
        "zh-CN": "同花顺股票、海外股票、指数、基金与债券数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "hexin-bond",
      routeId: "finance_hexin_bond",
      plugin: "hexin",
      requiresPaidPlan: true,
      displayName: { en: "RoyalFlush iFinD", "zh-CN": "同花顺" },
      description: {
        en: "MCP services for RoyalFlush iFinD stock, global stock, index, fund, and bond data.",
        "zh-CN": "同花顺股票、海外股票、指数、基金与债券数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "wind-stock",
      routeId: "finance_wind_stock",
      plugin: "wind",
      requiresPaidPlan: true,
      displayName: { en: "Wind", "zh-CN": "Wind 万得" },
      description: {
        en: "MCP services for Wind stock, global stock, index, fund, bond, economic, and document data.",
        "zh-CN": "万得股票、海外股票、指数、基金、债券、宏观经济与公告研报数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "wind-global-stock",
      routeId: "finance_wind_global_stock",
      plugin: "wind",
      requiresPaidPlan: true,
      displayName: { en: "Wind", "zh-CN": "Wind 万得" },
      description: {
        en: "MCP services for Wind stock, global stock, index, fund, bond, economic, and document data.",
        "zh-CN": "万得股票、海外股票、指数、基金、债券、宏观经济与公告研报数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "wind-index",
      routeId: "finance_wind_index",
      plugin: "wind",
      requiresPaidPlan: true,
      displayName: { en: "Wind", "zh-CN": "Wind 万得" },
      description: {
        en: "MCP services for Wind stock, global stock, index, fund, bond, economic, and document data.",
        "zh-CN": "万得股票、海外股票、指数、基金、债券、宏观经济与公告研报数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "wind-fund",
      routeId: "finance_wind_fund",
      plugin: "wind",
      requiresPaidPlan: true,
      displayName: { en: "Wind", "zh-CN": "Wind 万得" },
      description: {
        en: "MCP services for Wind stock, global stock, index, fund, bond, economic, and document data.",
        "zh-CN": "万得股票、海外股票、指数、基金、债券、宏观经济与公告研报数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "wind-bond",
      routeId: "finance_wind_bond",
      plugin: "wind",
      requiresPaidPlan: true,
      displayName: { en: "Wind", "zh-CN": "Wind 万得" },
      description: {
        en: "MCP services for Wind stock, global stock, index, fund, bond, economic, and document data.",
        "zh-CN": "万得股票、海外股票、指数、基金、债券、宏观经济与公告研报数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "wind-economic",
      routeId: "finance_wind_economic",
      plugin: "wind",
      requiresPaidPlan: true,
      displayName: { en: "Wind", "zh-CN": "Wind 万得" },
      description: {
        en: "MCP services for Wind stock, global stock, index, fund, bond, economic, and document data.",
        "zh-CN": "万得股票、海外股票、指数、基金、债券、宏观经济与公告研报数据 MCP 服务。",
      },
      category: "finance",
    },
    {
      key: "wind-docs",
      routeId: "finance_wind_docs",
      plugin: "wind",
      requiresPaidPlan: true,
      displayName: { en: "Wind", "zh-CN": "Wind 万得" },
      description: {
        en: "MCP services for Wind stock, global stock, index, fund, bond, economic, and document data.",
        "zh-CN": "万得股票、海外股票、指数、基金、债券、宏观经济与公告研报数据 MCP 服务。",
      },
      category: "finance",
    },
  ],
};

const byKey = new Map(ZCODE_MCP_CATALOGUE.servers.map((s) => [s.key, s]));

/** Look up a served MCP server by its route key. */
export function lookupZcodeMcpServer(key) {
  return byKey.get(key) || null;
}

/** Upstream gateway origin (env override for testing / self-hosted gateways). */
export function resolveZcodeMcpUpstreamOrigin() {
  return process.env.ZCODE_MCP_UPSTREAM_ORIGIN || ZCODE_MCP_CATALOGUE.defaultUpstreamOrigin;
}

/** Upstream path for a catalogue entry: /api/v1/mcp/server/{routeId}. */
export function resolveZcodeMcpUpstreamPath(def) {
  return `/api/v1/mcp/server/${def.routeId}`;
}