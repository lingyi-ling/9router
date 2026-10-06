// CodeBuddy 桌面客户端（WorkBuddy Desktop 5.5.6）行为指纹事件链。
// 移植自 workbuddy2api-panel internal/upstream/desktop.go + internal/panel/autotask.go。
//
// v0.8.0 要点：桌面端点亮「需电脑端」类任务的关键不是独立端点，而是同一
// POST copilot.tencent.com/v2/report 通道上**不同的客户端指纹**（ideName/ideType=WorkBuddy、
// extName=workbuddy-desktop），以及各任务各自的判据事件组。本模块提供：
//   - 事件构造器（chat/buddyapp/template/playbook/canvas/expert/appearance/web…）
//   - 真实短对话（`/v2/chat/completions` SSE，取服务端 requestId，专家类任务必需）
//   - 17 个 PC 端成长任务的「一键完成」runner 与注册表 DESKTOP_TASK_RUNNERS
//
// 上报 200 ≠ 计分（上游异步计分 + 可能静默丢弃）：runner 统一回读进度并在达标时领奖。
import crypto from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { listAllTasks, acceptTasks, claimReward } from "./tasks.js";
import { buddyAgreement, buddyFirst } from "./travel.js";
import { runBlackCat } from "./blackcat.js";

// ── 常量 ────────────────────────────────────────────────────────────────
export const DESKTOP_UA = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1"; // 实测桌面 UA（5.5.6 内嵌 CLI 2.137.1）
export const DESKTOP_REPORT_PATH = "/v2/report";
export const DESKTOP_APPEARANCE_SET = "/v2/user-asset/appearance/set";
const DESKTOP_EXPERT_LIST_PATH = "/portal/operation-platform/market/expert/list";
const DESKTOP_CHAT_PATH = "/v2/chat/completions";

const DESKTOP_RELEASE_DATE = 1789036585355;
const DESKTOP_COMMIT = "5f9692923c93033111c51ad7b003eb80204a9b75";
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// 上报/动作间隔（对齐上游脚本实测口径，避免风控）
const REPORT_GAP_MS = 1050;
const EXPERT_SUMMON_GAP_MS = 6000; // v11 实测 8s 成功率 100%，取较保守的 6s
const CLAIM_POLL_ATTEMPTS = 4; // 与面板 claimPollAttempts 一致（异步计分等待）
const CLAIM_POLL_GAP_MS = 3000;
// 服务端 requestId 形状（cmb- 前缀 32hex 或裸 32hex）
const SERVER_ID_RE = /^(cmb-)?[0-9a-f]{32}$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 由 uid 稳定派生 36 位 hex 设备标识（machineId/sessionId 复用；幂等）。
 * 对齐 Go deriveID：sha256(`${salt}:${uid}`) 前 36 hex。
 * @param {string} uid
 * @param {string} salt
 * @returns {string}
 */
export function deriveDesktopId(uid, salt) {
  return crypto.createHash("sha256").update(`${salt}:${uid || ""}`).digest("hex").slice(0, 36);
}

/** 公共桌面指纹字段（注入每个事件；业务字段优先覆盖）。 */
function desktopFingerprint(cred) {
  const now = Date.now();
  const uid = cred?.uid || "";
  const nickname = cred?.nickname || cred?.userNickname || "";
  return {
    timezone: "Asia/Shanghai",
    reportDelay: 2000,
    userId: uid,
    username: nickname,
    userNickname: nickname,
    product: "SaaS",
    releaseDate: DESKTOP_RELEASE_DATE,
    commit: DESKTOP_COMMIT,
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    ideVersion: "5.5.6",
    machineId: deriveDesktopId(uid, "machine"),
    sessionId: deriveDesktopId(uid, "session"),
    extName: "workbuddy-desktop",
    extVersion: "5.5.6",
    os: "win32",
    arch: "x64",
    osVersion: "10.0.26220",
    cpuCores: 20,
    memorySize: 24,
    timestamp: now,
    presentAt: now,
  };
}

/**
 * 以桌面客户端指纹向 copilot.tencent.com/v2/report 批量上报事件。
 * @param {object} client
 * @param {Array<object>} events - 业务载荷（eventCode 等）；公共指纹自动注入
 */
export async function reportDesktopEvent(client, events) {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) throw new Error("desktop report: no events");
  const cred = client.credential || {};
  const fp = desktopFingerprint(cred);
  const body = list.map((ev) => ({ ...fp, ...ev }));
  const headers = {
    Authorization: `Bearer ${cred.accessToken || ""}`,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": DESKTOP_UA,
    "X-Domain": client.chatBase(),
    "X-Product": "SaaS",
    "X-Request-ID": deriveDesktopId(cred.uid, "req") + String(Date.now() % 1000000),
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  await client.doJSON(`${client.chatBase()}${DESKTOP_REPORT_PATH}`, { method: "POST", headers, body });
}

/** 应用外观主题（实测端点；纯 set 需配合 appearance_skin_apply 事件才计分）。 */
export async function setAppearanceTheme(client, resourceKey) {
  const cred = client.credential || {};
  const headers = {
    Authorization: `Bearer ${cred.accessToken || ""}`,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": DESKTOP_UA,
    "X-Product": "SaaS",
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  await client.doJSON(`${client.chatBase()}${DESKTOP_APPEARANCE_SET}`, {
    method: "POST",
    headers,
    body: { kind: "theme", resource_key: resourceKey },
  });
}

/** 以 Web 端指纹向 www.workbuddy.cn/v2/report 上报单事件（Library_read 等页面行为）。 */
export async function reportWebEvent(client, eventCode, pageURL, elementID, elementName) {
  const cred = client.credential || {};
  const ev = {
    eventCode,
    timestamp: Date.now(),
    reportDelay: 0,
    pageURL,
    elementId: elementID,
    elementName,
    os: "Win32",
    arch: "",
    osVersion: "10.0",
    userAgent: WEB_UA,
    machineId: deriveDesktopId(cred.uid, "webmachine"),
    userId: cred.uid || "",
    userNickname: cred.nickname || cred.userNickname || "",
    enterpriseId: cred.enterpriseId || "",
  };
  const headers = {
    Authorization: `Bearer ${cred.accessToken || ""}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-client-platform": "web",
    Origin: client.webBase(),
    Referer: pageURL,
    "User-Agent": WEB_UA,
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  await client.doJSON(`${client.webBase()}${DESKTOP_REPORT_PATH}`, { method: "POST", headers, body: [ev] });
}

// ── 事件构造器（纯函数，逐字对齐 Go 载荷） ──────────────────────────────

/** 一次「桌面端成功对话」的完整事件链（实测点亮 RichMeow_Chat）。 */
export function desktopChatSequence(conversationId, requestId, messageId, modelId, modelName) {
  const mk = (code, extra) => ({ eventCode: code, ...(extra || {}) });
  return [
    mk("agent_task_created", {
      source: "LOCAL", name: "working", task_target: "local", mode: "craft",
      requestModelId: modelId, requestModelName: modelName,
      has_repo: false, repo_type: "none", workspace_type: "empty",
      has_connector: false, connector_types: [],
      has_mention: false, mention_types: [],
      has_template: false, action: "", template_name: "",
      has_expert: false, expert_id: "", expert_name: "", expert_industry_id: "",
      has_skill: false, skill_names: [],
      conversationId, messageId, buddyId: "", buddyName: "",
    }),
    mk("chat_message_send", {
      messageId: `${messageId}-assistant`, historyCount: 0,
      isContextTruncated: false, currentStepCount: 1,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId, agentName: "cli", agentType: "main",
    }),
    mk("chat_request_send", {
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: "", mentionContextCount: 0, command: "",
      recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId, agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationId,
      "codebuddy.conversation_request_id": requestId,
    }),
    mk("chat_message_response", {
      messageId: `${messageId}-assistant`, responseModelId: modelId,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      firstTokenAt: Date.now(), traceId: requestId,
      conversationId, rootRequestId: requestId, parentConversationId: conversationId,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationId,
      "codebuddy.conversation_request_id": requestId,
    }),
    mk("chat_message_status", {
      messageId: `${messageId}-assistant`, messageErrorCode: "0",
      traceId: requestId, rootRequestId: requestId,
      parentConversationId: conversationId, agentName: "cli", agentType: "main",
    }),
    mk("chat_request_response", {
      mode: "craft", toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      rootRequestId: requestId, parentConversationId: conversationId,
    }),
  ];
}

/** 「进入 Buddy 应用」五连事件（点亮 Buddy_App 与 Buddy_App_QQ）。 */
export function desktopBuddyAppSequence(buddyId, buddyName) {
  const mk = (code, extra) => ({ eventCode: code, mode: "LOCAL", buddyId, buddyName, ...(extra || {}) });
  return [
    mk("buddyapp_discover_click"),
    mk("buddyapp_show", { elementId: buddyId, elementName: buddyName, position: 2 }),
    mk("buddyapp_enter_click", { elementId: buddyId, elementName: buddyName, position: 2, isFirstPage: "1" }),
    mk("buddyapp_auth_confirm_click", { elementId: buddyId, elementName: buddyName }),
    mk("buddyapp_bindaccount_skip_click", { elementId: buddyId, elementName: buddyName }),
  ];
}

/** 「定时任务创建成功」事件（点亮 automation_1）。 */
export function desktopAutomationCreateEvent(name) {
  return {
    eventCode: "automated_task_create_suc", name,
    source: "manually", modelId: "fast-model", modelIsThinking: true,
    connectorCount: 0, skills: "", skillCount: 0,
    scheduleType: "once", mode: "LOCAL",
  };
}

/** 「使用模板创建任务」事件组（JOIN chat 链；点亮 template_5 计数）。 */
export function desktopTemplateUseSequence(conversationId, requestId, templateId, templateName) {
  const events = desktopChatSequence(conversationId, requestId, `msg-${templateId}`, "fast-model", "fast-model");
  events.push(
    {
      eventCode: "agent_task_created_with_template", mode: "working",
      isCustomModel: false, id: templateId, name: templateName, requestId,
    },
    { eventCode: "template_used", template_id: templateId, task_mode: "working" },
  );
  return events;
}

/** 「灵感案例做同款」事件组（JOIN chat 链；点亮 playbook_prompt）。 */
export function desktopPlaybookPromptSequence(conversationId, requestId, caseId, caseName) {
  const events = desktopChatSequence(conversationId, requestId, "msg-pb", "fast-model", "fast-model");
  const payload = { id: caseId, name: caseName, type: "document", categoryId: "", categoryName: "" };
  events.push(
    {
      eventCode: "web_element_click", pageName: "playbook_detail",
      elementId: "playbook_ctaClick", elementName: caseName, source: "discover",
    },
    { eventCode: "playbook_cta_click", source: "discover", position: 0, ...payload },
    { eventCode: "playbook_prompt_send", conversationId, requestId, ...payload },
  );
  return events;
}

/** 「设计创意画布」事件组（Ardot create_design 遥测；点亮 create_canvas）。 */
export function desktopDesignCanvasSequence(conversationId, requestId) {
  const events = desktopChatSequence(conversationId, requestId, "msg-canvas", "fast-model", "fast-model");
  events.push(
    {
      eventCode: "wbx_design_canvas_task_create", conversationId, requestId,
      source: "summon_keyword", cost: 12000, isSuccessful: true,
    },
    {
      eventCode: "wbx_design_canvas_open", conversationId, requestId,
      id: `ardot-file-${requestId.slice(-8)}`,
      source: "summon_keyword", type: "page", cost: 13000, isSuccessful: true,
    },
  );
  return events;
}

/** 归一化专家市场条目（上游 JSON 字段名 → 内部驼峰）。 */
function normalizeExpert(e) {
  return {
    expertId: e?.expert_id || e?.expertId || "",
    expertType: e?.expert_type || e?.expertType || "",
    displayNameZH: e?.display_name_zh || e?.displayNameZH || "",
    professionZH: e?.profession_zh || e?.professionZH || "",
    version: e?.version || "",
    categories: Array.isArray(e?.categories) ? e.categories : [],
  };
}

/** 拉取专家市场真实专家列表（expert_actual_use 要求 id 真实存在）。 */
export async function marketExpertList(client, expertType = "") {
  const cred = client.credential || {};
  const body = { page: 1, page_size: 20, sort_by: "reco_rank", sort_order: "desc" };
  if (expertType) body.expert_type = expertType;
  const headers = {
    Authorization: `Bearer ${cred.accessToken || ""}`,
    "Content-Type": "application/json",
    "User-Agent": DESKTOP_UA,
    "X-Domain": client.chatBase(),
    "X-Product": "SaaS",
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  const data = await client.doJSON(`${client.chatBase()}${DESKTOP_EXPERT_LIST_PATH}`, {
    method: "POST",
    headers,
    body,
  });
  const experts = Array.isArray(data?.experts) ? data.experts : [];
  return experts.map(normalizeExpert);
}

/** 从 SSE 流中抓第一个服务端 requestId（自造 UUID 不计数）。 */
async function readServerRequestId(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let searchFrom = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('"id":"', searchFrom);
      while (idx >= 0) {
        const rest = buf.slice(idx + 6);
        const end = rest.indexOf('"');
        if (end > 0) {
          const id = rest.slice(0, end);
          if (SERVER_ID_RE.test(id)) return id;
        }
        searchFrom = idx + 1;
        idx = buf.indexOf('"id":"', searchFrom);
      }
      if (done || buf.length > 1 << 20) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return "";
}

/**
 * 发一条真实桌面指纹 chat 请求（可带 X-Expert-Id），取**服务端** requestId。
 * 对齐 Go DesktopChatWithExpert：expert/skill/lighthouse 类任务的 requestId 必须用它。
 * @param {object} client
 * @param {string} [expertId]
 * @param {{model?:string, prompt?:string}} [opts]
 * @returns {Promise<{conversationId:string, requestId:string}>}
 */
export async function desktopChatWithExpert(client, expertId = "", opts = {}) {
  const cred = client.credential || {};
  const conversationId = `wb2api-conv-${Date.now()}`;
  const body = {
    model: opts.model || "fast-model",
    messages: [
      { role: "system", content: "You are a helpful assistant. 当前处于中文环境，使用简体中文回答。" },
      { role: "user", content: opts.prompt || "1+1等于几？直接回答。" },
    ],
    agent: "cli",
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true },
  };
  const headers = {
    Authorization: `Bearer ${cred.accessToken || ""}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": DESKTOP_UA,
    "X-Domain": client.chatBase(),
    "X-Product": "SaaS",
    "X-User-Id": cred.uid || "",
    "X-Conversation-ID": conversationId,
    "X-Request-ID": String(Date.now()),
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": "5.5.6",
    "x-codebuddy-request": "1",
  };
  if (expertId) headers["X-Expert-Id"] = expertId;
  const resp = await proxyAwareFetch(`${client.chatBase()}${DESKTOP_CHAT_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.CODEBUDDY_TIMEOUT_MS || 15_000)),
  });
  if (resp.status !== 200) {
    const raw = await resp.text().catch(() => "");
    throw new Error(`chat http ${resp.status}: ${raw.slice(0, 200)}`);
  }
  const requestId = await readServerRequestId(resp);
  if (!requestId) throw new Error("SSE 中未找到服务端 requestId");
  return { conversationId, requestId };
}

/** 「召唤平台专家」事件组（web_element_click + expert_summon_click + expert_summoned）。 */
export function desktopExpertSummonSequence(expert) {
  const cat = typeof expert?.categories?.[0] === "string" ? expert.categories[0] : "expert-all";
  const ver = expert?.version || "1.0.0";
  return [
    {
      eventCode: "web_element_click", source: expert.expertId, type: cat, version: ver,
      elementId: "expert_summon_click", elementName: "立即召唤",
      pageURL: "/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html",
    },
    {
      eventCode: "expert_summon_click", id: expert.expertId, name: expert.displayNameZH,
      expertTitle: expert.professionZH, type: "expert-all", position: 0,
      expertType: expert.expertType, version: ver, mode: "LOCAL",
    },
    {
      eventCode: "expert_summoned", id: expert.expertId, name: expert.displayNameZH,
      expertTitle: expert.professionZH, type: "expert-all",
    },
  ];
}

function desktopExpertActualUse(expert, conversationId, requestId) {
  const cat = typeof expert?.categories?.[0] === "string" ? expert.categories[0] : "expert-all";
  const ver = expert?.version || "1.0.0";
  return {
    eventCode: "expert_actual_use",
    id: expert.expertId, name: expert.displayNameZH, expertTitle: expert.professionZH,
    type: cat, expertType: expert.expertType, source: "builtin", version: ver,
    cost: 9000, characterCount: 14,
    conversationId, requestId, messageId: `msg-${requestId.slice(-8)}`,
    requestModelId: "fast-model", requestModelName: "fast-model",
  };
}

/** 「专家真实使用」事件（mode=craft；requestId 必须是服务端 id）。 */
export function desktopExpertActualUseEvent(expert, conversationId, requestId) {
  return { ...desktopExpertActualUse(expert, conversationId, requestId), mode: "craft" };
}

/** mode=LOCAL 变体（Expert_lighthouse 判据要求 LOCAL）。 */
export function desktopExpertActualUseLocal(expert, conversationId, requestId) {
  return { ...desktopExpertActualUse(expert, conversationId, requestId), mode: "LOCAL" };
}

// ── 一键完成：accept → 判据上报 → 回读 → 领奖 ──────────────────────────

/** 有界轮询等待任务达标（上游异步计分）。 */
async function waitClaimable(client, code) {
  let t = (await listAllTasks(client).catch(() => [])).find((x) => x.taskCode === code) || null;
  if (t && (t.claimable || t.claimed)) return t;
  for (let i = 1; i < CLAIM_POLL_ATTEMPTS; i++) {
    await sleep(CLAIM_POLL_GAP_MS);
    const all = await listAllTasks(client).catch(() => null);
    if (!all) return t;
    const t2 = all.find((x) => x.taskCode === code);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed) return t;
    }
  }
  return t;
}

/** 单个 PC 任务的一键闭环（幂等：已领取直接跳过）。 */
async function oneClick(client, code, reportFn) {
  const before = (await listAllTasks(client).catch(() => [])).find((x) => x.taskCode === code) || null;
  if (before && before.claimed) return { taskCode: code, status: "skipped", message: "已完成（已领取）" };
  if (before && before.acceptStatus !== "accepted" && before.acceptStatus !== "completed") {
    try {
      await acceptTasks(client, [code]); // 报名；失败不阻塞（行为事件才是判据）
    } catch {
      /* 行为事件才是进度判据 */
    }
  }
  const message = await reportFn();
  const after = await waitClaimable(client, code);
  const out = {
    taskCode: code,
    status: "done",
    message,
    progressAfter: after ? (after.target > 0 ? `${after.current}/${after.target}` : after.acceptStatus || "?") : "?",
  };
  if (after && after.claimable) {
    try {
      const r = await claimReward(client, code);
      out.claimed = true;
      out.credit = r.credit;
      out.energy = r.energy;
    } catch (err) {
      out.claimError = err.message;
    }
  }
  return out;
}

/** chat_5：按差额上报对话活跃事件。 */
export function runChat5(client) {
  return oneClick(client, "chat_5", async () => {
    const t = (await listAllTasks(client).catch(() => [])).find((x) => x.taskCode === "chat_5");
    if (!t) throw new Error("任务不存在");
    const target = t.target > 0 ? t.target : 5;
    const need = target - t.current;
    if (need <= 0) return "进度已达标，无需上报";
    for (let i = 0; i < need; i++) {
      await client.reportChatActivity(`wb2api-chat5-${Date.now()}-${i}`, "");
      if (i < need - 1) await sleep(REPORT_GAP_MS);
    }
    return `已补报 ${need} 条对话事件`;
  });
}

/** first_buddy：解锁上报 → 同意协议 → 领养第一只 Buddy。 */
export function runFirstBuddy(client) {
  return oneClick(client, "first_buddy", async () => {
    await client.reportChatActivity(`wb2api-adopt-${Date.now()}`, "");
    await sleep(REPORT_GAP_MS); // 给上游事件处理留时间
    await buddyAgreement(client);
    const res = await buddyFirst(client);
    if (!res.ok && res.skipped === "task_incomplete") {
      return "前置已上报，但领养门槛未过（上游要求当日活跃），请稍后重试";
    }
    return "已领取 Buddy（+300 分 +8 能量）";
  });
}

/** Model_chat_GLM5.2：accept → glm-5.2 真实对话一次 → 对齐模型上报。 */
export function runModelChat(client) {
  const code = "Model_chat_GLM5.2";
  const modelId = "glm-5.2";
  const modelName = "GLM-5.2";
  return oneClick(client, code, async () => {
    // v0.8.0：真实对话复用文档化的桌面 chat 形态（/v2/chat/completions + 桌面指纹）
    await desktopChatWithExpert(client, "", { model: modelId, prompt: "hi，请回复一句话" });
    await sleep(REPORT_GAP_MS);
    try {
      await client.reportChatActivity(`wb2api-glm52-${Date.now()}`, "", modelId, modelName);
    } catch (err) {
      return `对话已完成，但进度上报失败：${err.message}`;
    }
    return "已完成 glm-5.2 对话并上报";
  });
}

/** RichMeow_Chat：桌面指纹完整对话事件链。 */
export function runRichMeow(client) {
  return oneClick(client, "RichMeow_Chat", async () => {
    const ms = Date.now();
    const conv = `wb2api-rm-${ms}`;
    const req = `wb2api-rm-req-${ms}`;
    const msg = `req-${ms}-user`;
    await reportDesktopEvent(client, desktopChatSequence(conv, req, msg, "fast-model", "fast-model"));
    return "已按桌面端指纹上报完整对话事件链（agent_task_created→chat_response）";
  });
}

/** Buddy_App / Buddy_App_QQ：buddyapp 五连事件（同一组覆盖两任务）。 */
export function runBuddyApp(client, code = "Buddy_App") {
  return oneClick(client, code, async () => {
    await reportDesktopEvent(client, desktopBuddyAppSequence("cb_y5Dy46tPQGGWtueMxXbe", "企鹅教师助手"));
    return "已上报 buddyapp 进入五连事件（同时覆盖 Buddy_App 与 Buddy_App_QQ）";
  });
}

/** automation_1：定时任务创建成功事件。 */
export function runAutomationCreate(client) {
  return oneClick(client, "automation_1", async () => {
    await reportDesktopEvent(client, [desktopAutomationCreateEvent("wb2api 自动化")]);
    return "已上报定时任务创建事件";
  });
}

/** Library_read：web 域资料库介绍阅读点击。 */
export function runLibraryRead(client) {
  return oneClick(client, "Library_read", async () => {
    const docURL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
    await reportWebEvent(client, "web_element_click", docURL, "library_doc_intro_click", "WorkBuddy资料库介绍");
    return "已上报资料库介绍阅读事件";
  });
}

/** template_5：模板使用事件组 ×5。 */
export function runTemplateUse(client) {
  return oneClick(client, "template_5", async () => {
    const templates = [
      ["1", "深度研究"], ["2", "周报生成"], ["3", "竞品分析"], ["4", "活动策划"], ["5", "代码评审"],
    ];
    for (let i = 0; i < templates.length; i++) {
      const ms = Date.now();
      const [id, name] = templates[i];
      const events = desktopTemplateUseSequence(`wb2api-tpl-${ms}-${i}`, `wb2api-tpl-req-${ms}-${i}`, id, name);
      try {
        await reportDesktopEvent(client, events);
      } catch (err) {
        return `第 ${i + 1} 组模板事件上报失败: ${err.message}`;
      }
      await sleep(300);
    }
    return "已上报 template_used ×5";
  });
}

/** playbook_prompt：灵感案例 Dialog 发送 Prompt。 */
export function runPlaybookPrompt(client) {
  return oneClick(client, "playbook_prompt", async () => {
    const ms = Date.now();
    const events = desktopPlaybookPromptSequence(
      `wb2api-pb-${ms}`, `wb2api-pb-req-${ms}`, "pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸",
    );
    await reportDesktopEvent(client, events);
    return "已上报 playbook_cta_click + playbook_prompt_send";
  });
}

/** create_canvas：设计创意画布创建事件组。 */
export function runCreateCanvas(client) {
  return oneClick(client, "create_canvas", async () => {
    const ms = Date.now();
    const events = desktopDesignCanvasSequence(`wb2api-canvas-${ms}`, `wb2api-canvas-req-${ms}`);
    await reportDesktopEvent(client, events);
    return "已上报 wbx_design_canvas_task_create/open";
  });
}

/** 专家召唤 + 真实使用批量（失败逐个继续）。 */
async function runExpertBatch(client, expertType, count) {
  const experts = await marketExpertList(client, expertType);
  if (!experts.length) throw new Error("专家市场列表为空");
  let ok = 0;
  for (let i = 0; i < experts.length && ok < count; i++) {
    const e = experts[i];
    try {
      await reportDesktopEvent(client, desktopExpertSummonSequence(e)); // 召唤链
      const { conversationId, requestId } = await desktopChatWithExpert(client, e.expertId); // 真实 chat
      const events = desktopChatSequence(
        conversationId, requestId, `msg-${requestId.slice(-8)}`, "fast-model", "fast-model",
      );
      events.push(desktopExpertActualUseEvent(e, conversationId, requestId)); // JOIN 服务端 requestId
      await reportDesktopEvent(client, events);
      ok++;
    } catch {
      continue; // 单专家失败不影响后续
    }
    if (i < experts.length - 1) await sleep(EXPERT_SUMMON_GAP_MS);
  }
  return `已对 ${ok} 位真实专家完成召唤+使用链（类型 ${expertType}）`;
}

/** expert_5：真实专家召唤+使用链 ×5。 */
export function runExpertUse(client) {
  return oneClick(client, "expert_5", () => runExpertBatch(client, "agent", 5));
}

/** Expert_team_use_3：专家团召唤+使用链 ×3。 */
export function runExpertTeamUse(client) {
  return oneClick(client, "Expert_team_use_3", () => runExpertBatch(client, "team", 3));
}

/** Hp_Appearance：主题 set API + 皮肤生效事件。 */
export function runAppearance(client) {
  return oneClick(client, "Hp_Appearance", async () => {
    const themeKey = "theme-tkmw7j"; // 和平精英激战金秋（判据主题）
    await setAppearanceTheme(client, themeKey);
    await sleep(2000);
    await reportDesktopEvent(client, [
      {
        eventCode: "appearance_skin_apply", action: "apply", source: "settings_close",
        id: themeKey, vipLevel: 0, series: "", type: "unknown",
      },
    ]);
    return "已设置主题并上报皮肤生效事件";
  });
}

/** skill_1：真实对话 + skill_info 技能加载事件（对齐真实抓包形状）。 */
export function runSkillFresh(client) {
  return oneClick(client, "skill_1", async () => {
    const { conversationId, requestId } = await desktopChatWithExpert(client, "");
    const msgId = `msg-${requestId.slice(-8)}`;
    const events = desktopChatSequence(conversationId, requestId, msgId, "fast-model", "fast-model");
    for (const ev of events) {
      if (ev.eventCode === "chat_message_response") ev.finishReason = "tool_calls"; // 模型发起工具调用语义
    }
    events.push({
      eventCode: "skill_info",
      id: "润泽小馆·日报撰写",
      skillId: "skill_2097350077599879168",
      skillVersion: "1.0.0",
      toolStatus: "success",
      fileCount: 56,
      source: "workbuddy-desktop",
      conversationId, requestId, messageId: msgId,
      requestModelId: "fast-model", requestModelName: "fast-model",
      traceId: requestId,
    });
    await reportDesktopEvent(client, events);
    return "已上报真实对话 + skill_info 技能加载事件";
  });
}

/** Expert_lighthouse：轻量云专家召唤+使用链（真实 requestId，mode=LOCAL）。 */
export function runExpertLighthouse(client) {
  return oneClick(client, "Expert_lighthouse", async () => {
    const lhId = "ex_2cvvUZQhDyeJ";
    let lh = {
      expertId: lhId, expertType: "agent",
      displayNameZH: "腾讯轻量云专家", professionZH: "腾讯轻量云专家",
      version: "1.0.2", categories: [],
    };
    // 市场列表命中真实条目则用其信息（version 等以服务端为准）
    try {
      const experts = await marketExpertList(client, "agent");
      const hit = experts.find((e) => e.expertId === lhId);
      if (hit) lh = hit;
    } catch {
      /* 列表失败沿用内置条目 */
    }
    await reportDesktopEvent(client, desktopExpertSummonSequence(lh));
    const { conversationId, requestId } = await desktopChatWithExpert(client, lhId);
    const events = desktopChatSequence(
      conversationId, requestId, `msg-${requestId.slice(-8)}`, "fast-model", "fast-model",
    );
    for (const ev of events) {
      if (ev.eventCode === "agent_task_created") {
        ev.has_expert = true;
        ev.expert_id = lh.expertId;
        ev.expert_name = lh.displayNameZH;
        ev.expert_industry_id = "";
      }
    }
    const useEvent = desktopExpertActualUseLocal(lh, conversationId, requestId);
    useEvent.type = ""; // 对齐真实样本：轻量云专家 actual_use type 为空、cost=0
    useEvent.cost = 0;
    events.push(useEvent);
    await reportDesktopEvent(client, events);
    return "已上报轻量云专家召唤+使用链（真实对话 requestId）";
  });
}

// ── 注册表（17 个 PC 端成长任务） ───────────────────────────────────────

/**
 * task_code → 一键完成 runner（每个 runner 接收 client，返回结果对象）。
 * 覆盖 README「成长任务一键完成（17/18）」的 17 个可自动化任务。
 */
export const DESKTOP_TASK_RUNNERS = {
  chat_5: (client) => runChat5(client),
  first_buddy: (client) => runFirstBuddy(client),
  "Model_chat_GLM5.2": (client) => runModelChat(client),
  RichMeow_Chat: (client) => runRichMeow(client),
  Buddy_App: (client) => runBuddyApp(client, "Buddy_App"),
  Buddy_App_QQ: (client) => runBuddyApp(client, "Buddy_App_QQ"),
  automation_1: (client) => runAutomationCreate(client),
  Library_read: (client) => runLibraryRead(client),
  template_5: (client) => runTemplateUse(client),
  playbook_prompt: (client) => runPlaybookPrompt(client),
  create_canvas: (client) => runCreateCanvas(client),
  expert_5: (client) => runExpertUse(client),
  Expert_team_use_3: (client) => runExpertTeamUse(client),
  Hp_Appearance: (client) => runAppearance(client),
  skill_1: (client) => runSkillFresh(client),
  Expert_lighthouse: (client) => runExpertLighthouse(client),
  black_cat: (client) => runBlackCat(client),
};

/** 可自动化任务 code 列表（顺序对齐 Go autoActions，先解锁依赖项）。 */
export const AUTO_TASK_CODES = Object.keys(DESKTOP_TASK_RUNNERS);

/**
 * 「一键完成全部可自动任务」：逐项执行 runner，单项失败不影响后续。
 * @param {object} client
 * @returns {Promise<Array<object>>} 逐项结果
 */
export async function runAutoTasks(client) {
  const out = [];
  for (const code of AUTO_TASK_CODES) {
    const runner = DESKTOP_TASK_RUNNERS[code];
    if (!runner) continue;
    try {
      out.push(await runner(client));
    } catch (err) {
      out.push({ taskCode: code, status: "error", message: err.message });
    }
    await sleep(REPORT_GAP_MS); // 项间节流
  }
  return out;
}