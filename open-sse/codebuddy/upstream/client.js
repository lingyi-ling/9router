// CodeBuddy (腾讯) 账号激励子系统 —— 上游客户端核心。
//
// 移植自 workbuddy2api-panel（Go）internal/upstream/{headers,client,report}.go：
// 统一处理 realm(cn/global) 路由、出站指纹头族、{code,msg,data} 信封与错误分类。
//
// 端点族：
//   chat 域（copilot.tencent.com，CN）：growth 任务 / 猫猫旅行 / 连登 / 领奖
//   billing 域（www.codebuddy.cn，CN）：签到 / 余额 / 活跃上报 /v2/report
//   web 域（www.workbuddy.cn，CN）：Web 成长中心领奖 / 账号资料
//   global realm：base 切 https://www.workbuddy.ai，路径去掉 /v2（billing/meter 族）
//
// v0.8.0 移植：仅保留激励/任务自动化所需部分（不含聊天代理链路）。
import crypto from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

// ── 基础域 ────────────────────────────────────────────────────────────────
export const CODEBUDDY_BASES = {
  chatCN: "https://copilot.tencent.com",
  billingCN: "https://www.codebuddy.cn",
  webCN: "https://www.workbuddy.cn",
  global: "https://www.workbuddy.ai",
};

const DEFAULT_CLIENT_VERSION = "5.5.4";
const DEFAULT_CLI_VERSION = "2.137.1";

// billing/meter 族路径（签到/余额）：global 先无 /v2 前缀，404 再换有 /v2。
const BILLING_METER_PATH = "/billing/meter/get-user-resource";
const DAILY_CHECKIN_PATH = "/billing/meter/daily-checkin";
const BILLING_METER_PATH_V2 = "/v2/billing/meter/get-user-resource";
const DAILY_CHECKIN_PATH_V2 = "/v2/billing/meter/daily-checkin";

const REPORT_PATH = "/v2/report";

// 「今天已签到」业务错误关键词（幂等拒绝，不算失败）。
const ALREADY_CHECKIN_MARKERS = [
  "already checked in", "already checkin", "checked in today", "today already",
  "已签到", "今天已签到", "重复签到",
];

/** 上游错误种类（移植 ErrKind 的激励相关子集）。 */
export const CB_ERROR_KIND = {
  NONE: "none",
  NOT_FOUND: "not_found",
  FORBIDDEN: "forbidden",
  UNAUTHORIZED: "unauthorized",
  SERVER: "server",
  CLIENT: "client",
  TRANSPORT: "transport",
};

export class CodeBuddyError extends Error {
  constructor(kind, status, message) {
    super(`codebuddy upstream ${kind} (http ${status || "-"}): ${message}`);
    this.name = "CodeBuddyError";
    this.kind = kind;
    this.status = status;
    this.upstreamMessage = message;
  }
}

/** HTTP 状态 → 错误种类。 */
export function classifyStatus(status) {
  if (status === 404) return CB_ERROR_KIND.NOT_FOUND;
  if (status === 401) return CB_ERROR_KIND.UNAUTHORIZED;
  if (status === 403) return CB_ERROR_KIND.FORBIDDEN;
  if (status >= 500) return CB_ERROR_KIND.SERVER;
  if (status >= 400) return CB_ERROR_KIND.CLIENT;
  return CB_ERROR_KIND.NONE;
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/** uid + 用途盐 → 36 hex 稳定设备/会话标识（跨重启恒定、账号间互异）。 */
export function deriveAccountStableId(uid, purpose) {
  const h = crypto.createHash("sha256").update(`wb2a:${purpose}:${uid}`).digest("hex");
  return h.slice(0, 36);
}

/**
 * 构造绑定到单个账号凭证的客户端。
 * @param {object} c
 * @param {string} c.accessToken
 * @param {string} [c.uid]
 * @param {string} [c.enterpriseId]
 * @param {string} [c.domain]
 * @param {string} [c.realm] - "cn" | "global"
 * @param {string} [c.deviceToken]
 * @param {string} [c.userAgent]
 * @param {typeof fetch} [c.fetchImpl]
 * @param {object} [c.proxyOptions]
 */
export function createCodeBuddyClient(c) {
  const realm = String(c.realm || (String(c.domain || "").includes("workbuddy.ai") ? "global" : "cn")).toLowerCase();
  const isGlobal = realm === "global";
  const fetchImpl = c.fetchImpl || ((url, init) => proxyAwareFetch(url, init, c.proxyOptions || null));
  const clientVersion = c.clientVersion || DEFAULT_CLIENT_VERSION;
  const cliVersion = c.cliVersion || DEFAULT_CLI_VERSION;

  const chatBase = () => (isGlobal ? CODEBUDDY_BASES.global : CODEBUDDY_BASES.chatCN);
  const billingBase = () => (isGlobal ? CODEBUDDY_BASES.global : CODEBUDDY_BASES.billingCN);
  const webBase = () => (isGlobal ? CODEBUDDY_BASES.global : CODEBUDDY_BASES.webCN);
  const originReferer = () => (isGlobal ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn");

  const userAgent = () => {
    if (c.userAgent) return c.userAgent;
    const platform = isGlobal ? "WorkBuddy AI" : "WorkBuddy";
    return `WorkBuddy/${clientVersion} ${platform}/${clientVersion} CLI/${cliVersion}`;
  };

  /** common 头（所有 API 共享）。 */
  function commonHeaders() {
    const origin = originReferer();
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Origin: origin,
      Referer: `${origin}/`,
      "User-Agent": userAgent(),
      "X-CodeBuddy-Request": "1",
      "Accept-Language": isGlobal ? "en-US" : "zh-CN",
    };
    if (c.uid) {
      h["X-Machine-ID"] = deriveAccountStableId(c.uid, "machine");
      h["X-Session-ID"] = deriveAccountStableId(c.uid, "session");
    }
    if (c.deviceToken) h["X-Device-Token"] = c.deviceToken;
    return h;
  }

  /** billing 域头（签到/余额/上报/旅行/tasks 等）。 */
  function billingHeaders() {
    const h = {
      Authorization: `Bearer ${c.accessToken || ""}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CodeBuddy-Request": "1",
      "Accept-Language": isGlobal ? "en-US" : "zh-CN",
      "User-Agent": `WorkBuddy/${clientVersion}`,
    };
    if (c.uid) h["X-User-Id"] = c.uid;
    if (c.enterpriseId) {
      h["X-Enterprise-Id"] = c.enterpriseId;
      h["X-Tenant-Id"] = c.enterpriseId;
    }
    if (c.domain) h["X-Domain"] = c.domain;
    if (c.deviceToken) h["X-Device-Token"] = c.deviceToken;
    return h;
  }

  /** Web 域头（成长中心领奖 / 账号资料）。 */
  function webHeaders() {
    const origin = isGlobal ? "https://www.workbuddy.ai" : "https://www.workbuddy.cn";
    const h = {
      Authorization: `Bearer ${c.accessToken || ""}`,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: origin,
      Referer: `${origin}/profile/growth-center`,
      "x-client-platform": "web",
      "User-Agent": userAgent(),
    };
    if (c.uid) h["X-User-Id"] = c.uid;
    if (c.enterpriseId) {
      h["X-Enterprise-Id"] = c.enterpriseId;
      h["X-Tenant-Id"] = c.enterpriseId;
    }
    if (c.domain) h["X-Domain"] = c.domain;
    return h;
  }

  /**
   * 发请求并解 {code,msg,data} 信封。HTTP 非 2xx / 业务 code != 0 → CodeBuddyError。
   * @returns {Promise<any>} envelope.data
   */
  async function doJSON(url, { method = "GET", headers, body } = {}) {
    let resp;
    try {
      resp = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.CODEBUDDY_TIMEOUT_MS || 15_000)),
      });
    } catch (err) {
      throw new CodeBuddyError(CB_ERROR_KIND.TRANSPORT, 0, err?.message || String(err));
    }
    const raw = await resp.text().catch(() => "");
    if (resp.status >= 400) {
      throw new CodeBuddyError(classifyStatus(resp.status), resp.status, truncate(raw, 200));
    }
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      throw new CodeBuddyError(CB_ERROR_KIND.TRANSPORT, resp.status, `parse failed: ${truncate(raw, 120)}`);
    }
    if (env && typeof env === "object" && env.code !== undefined && env.code !== 0) {
      const kind = classifyStatus(resp.status);
      throw new CodeBuddyError(kind === CB_ERROR_KIND.NONE ? CB_ERROR_KIND.CLIENT : kind, resp.status, `code=${env.code} msg=${truncate(env.msg || env.message, 160)}`);
    }
    return env?.data !== undefined ? env.data : env;
  }

  // ── 域内请求助手 ────────────────────────────────────────────────────────
  const billingJSON = (method, path, body) => doJSON(`${billingBase()}${path}`, { method, headers: billingHeaders(), body });
  const growthJSON = (method, path, body) => doJSON(`${chatBase()}${path}`, { method, headers: billingHeaders(), body });
  const growthJSONMP = (method, path, body) =>
    doJSON(`${chatBase()}${path}`, { method, headers: { ...billingHeaders(), "X-Client-Platform": "miniprogram" }, body });

  /** billing/meter 族：global 双路径 fallback（仅 404 换路径）。 */
  async function billingMeterJSON(paths, method, body) {
    let lastErr;
    for (let i = 0; i < paths.length; i++) {
      try {
        return await billingJSON(method, paths[i], body);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof CodeBuddyError) || err.kind !== CB_ERROR_KIND.NOT_FOUND || i === paths.length - 1) throw err;
      }
    }
    throw lastErr;
  }

  // ── 能力 ────────────────────────────────────────────────────────────────
  /** 每日签到。 */
  async function dailyCheckin() {
    const paths = isGlobal ? [DAILY_CHECKIN_PATH, DAILY_CHECKIN_PATH_V2] : [DAILY_CHECKIN_PATH_V2];
    await retryTransient(() => billingMeterJSON(paths, "POST", {}));
  }

  /** 余额 / 资源（供冷却账号余额恢复判断）。 */
  async function fetchBalance() {
    const paths = isGlobal ? [BILLING_METER_PATH, BILLING_METER_PATH_V2] : [BILLING_METER_PATH_V2];
    return retryTransient(() => billingMeterJSON(paths, "GET", undefined));
  }

  /** 有界瞬时重试（5xx / 网络层）：最多补打 2 次，间隔 2s、4s。 */
  async function retryTransient(fn) {
    let err;
    try {
      return await fn();
    } catch (e) {
      err = e;
    }
    if (!isTransient(err)) throw err;
    for (let i = 1; i <= 2; i++) {
      await new Promise((r) => setTimeout(r, i * 2000));
      try {
        return await fn();
      } catch (e) {
        err = e;
        if (!isTransient(err)) throw err;
      }
    }
    throw err;
  }

  function isTransient(err) {
    if (!err) return false;
    if (err instanceof CodeBuddyError) return err.kind === CB_ERROR_KIND.SERVER;
    return true; // 网络层错误
  }

  /** Web 域账号资料（uid 一致性核对 / 取 uid）。仅解析 uid + nickname。 */
  async function fetchAccountProfile() {
    const data = await doJSON(`${webBase()}/console/account`, { method: "GET", headers: webHeaders() });
    return { uid: typeof data?.uid === "string" ? data.uid : "", nickname: typeof data?.nickname === "string" ? data.nickname : "" };
  }

  /**
   * 刷新 access token（token 保活）。X-Refresh-Token 只允许出现在该端点。
   * @returns {Promise<{accessToken:string, refreshToken?:string, expiresIn?:number, domain?:string}>}
   */
  async function refreshToken() {
    if (!c.refreshToken) throw new CodeBuddyError(CB_ERROR_KIND.UNAUTHORIZED, 0, "no refreshToken");
    const headers = {
      ...commonHeaders(),
      "X-Refresh-Token": c.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
    };
    if (c.enterpriseId) headers["X-Enterprise-Id"] = c.enterpriseId;
    const data = await doJSON(`${chatBase()}/v2/plugin/auth/token/refresh`, { method: "POST", headers });
    if (!data?.accessToken) {
      throw new CodeBuddyError(CB_ERROR_KIND.UNAUTHORIZED, 0, "refresh_failed: no accessToken — re-login required");
    }
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || undefined,
      expiresIn: Number(data.expiresIn) || undefined,
      domain: data.domain || undefined,
    };
  }

  /**
   * 活跃上报（chat_request_send）。conversationId 调用方生成；requestId 空则回落 conversationId。
   * 一条上报同时点亮连登 + first_buddy 前置。userId 必填（缺失服务端静默丢弃）。
   */
  async function reportChatActivity(conversationId, requestId, modelId, modelName) {
    const now = Date.now();
    const rid = requestId || conversationId;
    const ev = {
      eventCode: "chat_request_send",
      timestamp: now,
      reportDelay: 0,
      mode: "craft",
      conversationId,
      requestId: rid,
      inputLength: 12,
      requestModelId: modelId || "deepseek-v4-flash",
      requestModelName: modelName || modelId || "DeepSeek V4 Flash",
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 0,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: "",
      mentionContextCount: 0,
      command: "",
      expertId: "",
      recommendId: "",
      skillId: "",
      skillCount: 0,
      totalCount: 0,
      fileUri: "",
      presentAt: now,
      traceId: "",
      rootRequestId: rid,
      parentConversationId: conversationId,
      agentName: "default",
      agentType: "conversation",
      userId: c.uid || "",
    };
    await billingJSON("POST", REPORT_PATH, [ev]);
  }

  return {
    realm,
    isGlobal,
    baseUrls: { chat: chatBase(), billing: billingBase(), web: webBase() },
    credential: { ...c },
    commonHeaders,
    billingHeaders,
    webHeaders,
    doJSON,
    billingJSON,
    growthJSON,
    growthJSONMP,
    billingMeterJSON,
    dailyCheckin,
    fetchBalance,
    fetchAccountProfile,
    refreshToken,
    reportChatActivity,
    // 供上层模块构造自定义路径请求
    chatBase,
    billingBase,
    webBase,
    userAgent,
  };
}

/** 判定「今天已签到」幂等错误。 */
export function isAlreadyCheckin(err) {
  if (!(err instanceof CodeBuddyError)) return false;
  const msg = err.upstreamMessage || "";
  const lower = msg.toLowerCase();
  return ALREADY_CHECKIN_MARKERS.some((m) => msg.includes(m) || lower.includes(m.toLowerCase()));
}

/** 判定「领养门槛未达标」（HTTP 400 + first_buddy 关键词，当日不应重试）。 */
export function isBuddyTaskIncomplete(err) {
  if (!(err instanceof CodeBuddyError) || err.status !== 400) return false;
  return (err.upstreamMessage || "").toLowerCase().includes("first_buddy task not completed yet");
}

/** 生成幂等 client_token（randomUUID 同款语义）。 */
export function clientToken() {
  return crypto.randomUUID();
}