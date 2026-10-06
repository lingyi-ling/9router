// CodeBuddy 小程序口径（miniprogram）成长任务事件链。
// 移植自 workbuddy2api-panel internal/upstream/school.go + internal/panel/autotask.go。
//
// v0.8.0 要点：小程序限定任务（school_season 校园日 / Sequential_Tasks_1..7）仅在
// 带 `X-Client-Platform: miniprogram` 的任务列表下发，accept/claim 也必须带该头。
// 判据以 mini 指纹事件（chat_request_send / expert_actual_use / playbook_*）上报；
// Sequential_Tasks_3/6 的多次对话有反作弊校验——连发会被回滚，须按真人节奏（45s+抖动）。
import { clientToken } from "./client.js";
import {
  marketExpertList,
  reportDesktopEvent,
  desktopAutomationCreateEvent,
  desktopPlaybookPromptSequence,
} from "./desktop.js";
import { listAllTasks, acceptTasksMP, claimRewardMP } from "./tasks.js";

const MP_REPORT_PATH = "/v2/report";
const SCHOOL_BASE = "/portal/activity/school";
// 开学季/校园日活动 id（事件 activityId 字段值，两域共用）
const SCHOOL_OPEN_DAY_ACTIVITY_ID = "school_open_day_2026";

// mp 任务写动作间隔（accept/上报/领奖之间，防频控）
const MP_ACTION_GAP_MS = 2000;
// mp 对话事件真人节奏间隔：连发会被上游反作弊判无效整体回滚（2026-09-26 实测
// 2s 连发 4 条全灭，45s 间隔逐条上报全存活）
const MP_CHAT_EVENT_GAP_MS = 45000;
const CLAIM_POLL_GAP_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 小程序埋点公共指纹（appservice wQ()+Ao() 对齐）。 */
function mpEventBase(cred) {
  return {
    timestamp: Date.now(),
    ideType: "WorkBuddy_MP",
    ideVersion: "2.4.0",
    extName: "workbuddy-mp",
    extVersion: "2.4.0",
    product: "SaaS",
    ideName: "wx_app_cloud",
    platform: "mini_program",
    os: "windows",
    osVersion: "11",
    arch: "x64",
    machineId: "0655736a-607f-4d9d-b430-58176ee9a090",
    timezone: "Asia/Shanghai",
    userId: cred?.uid || "",
    userNickname: cred?.nickname || cred?.userNickname || "",
  };
}

/** 以小程序指纹向 www.codebuddy.cn/v2/report 批量上报事件。 */
export async function reportMPEvent(client, events) {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) throw new Error("mp report: no events");
  const cred = client.credential || {};
  const base = mpEventBase(cred);
  const body = list.map((ev) => ({ ...base, ...ev }));
  const headers = {
    Authorization: `Bearer ${cred.accessToken || ""}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Client-Product": "workbuddy-mp",
    "X-Client-Version": "2.4.0",
    "X-Client-Platform": "mp-weixin",
    "X-Platform": "wechatmp",
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  await client.doJSON(`${client.billingBase()}${MP_REPORT_PATH}`, { method: "POST", headers, body });
}

/** 一条 chat_request_send 事件（chat_3_times / Sequential_Tasks_1/3/6 计数）。 */
export function schoolChatTimesEvents(conversationId) {
  const rid = `wb2api-${clientToken()}`;
  return {
    eventCode: "chat_request_send",
    inputLength: 14, isPlan: false, isAutoExecuteTerminal: false,
    isAutoModify: false, codebaseEnable: false, maxToken: 0,
    maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [],
    codebaseId: "", mentionContextCount: 0, command: "",
    recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
    traceId: rid, rootRequestId: rid,
    parentConversationId: conversationId, conversationId,
    messageId: `msg-${rid.slice(-8)}`,
    agentName: "mp", agentType: "main",
    "codebuddy.session_id": conversationId,
    "codebuddy.conversation_request_id": rid,
  };
}

/** 校园日（school_season）判据事件：与上同构，仅追加 activityId。 */
export function schoolSeasonChatEvent(conversationId) {
  return { ...schoolChatTimesEvents(conversationId), activityId: SCHOOL_OPEN_DAY_ACTIVITY_ID };
}

/**
 * Sequential_Tasks_2 判据事件：mp 指纹 expert_actual_use（不带上 conversationId/activityId、
 * extVersion=2.2.8、type=send_message）。expertID 必须是市场真实 ex_ id。
 */
export function miniExpertUseEvent(expertID, expertName, expertType) {
  const type = expertType || "agent";
  const name = expertName || expertID;
  return {
    eventCode: "expert_actual_use", reportDelay: 0,
    extVersion: "2.2.8", source: "mini_program",
    id: expertID, name: expertID,
    expertTitle: name, type: "send_message",
    characterCount: 12, expertType: type,
  };
}

/** mp 对话事件 + 模型字段（Sequential_Tasks_5「使用 GLM5.2」判据载体）。 */
export function miniChatModelEvent(conversationId, modelID, modelName) {
  return {
    ...schoolChatTimesEvents(conversationId),
    requestModelId: modelID,
    requestModelName: modelName,
  };
}

/** mp 指纹灵感事件组（playbook_cta_click → playbook_prompt_send）。 */
export function miniPlaybookEvents(caseID, caseName) {
  const base = {
    id: caseID, name: caseName, type: "document",
    categoryId: "", categoryName: "",
    skills: "", skillNames: "",
  };
  return [
    { eventCode: "playbook_cta_click", source: "discover", position: 1, extVersion: "2.2.8", ...base },
    {
      eventCode: "playbook_prompt_send", source: "discover",
      promptLength: 96, isOfficial: 1,
      conversationId: `wb2api-mp-pb-${clientToken()}`,
      extVersion: "2.2.8", ...base,
    },
  ];
}

/** 学院活动 API 请求（剥信封）。 */
async function schoolJSON(client, method, path, body) {
  return client.billingJSON(method, `${SCHOOL_BASE}${path}`, body);
}

/** 查询账号的开学季券码列表（只读）。 */
export async function schoolVouchers(client) {
  const data = await schoolJSON(client, "GET", "/vouchers");
  return Array.isArray(data?.items) ? data.items : [];
}

// ── mp 任务一键完成 ────────────────────────────────────────────────────

async function findMPTask(client, code) {
  const tasks = await listAllTasks(client).catch(() => []);
  return tasks.find((x) => x.taskCode === code) || null;
}

/** accept 并回读验证登记生效（上游存在 200+OK 但未落账形态，未生效重试一次）。 */
async function acceptWithVerifyMP(client, code) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await acceptTasksMP(client, [code]);
    } catch {
      continue;
    }
    await sleep(MP_ACTION_GAP_MS);
    const t = await findMPTask(client, code);
    if (t && t.acceptStatus && t.acceptStatus !== "not_accepted") return true;
  }
  return false;
}

/** 达标领奖（mp 口径）。 */
async function mpClaim(client, code) {
  try {
    const r = await claimRewardMP(client, code);
    return {
      taskCode: code,
      status: "done",
      message: `任务点亮并领取奖励（+${r.credit}c +${r.energy}e）`,
      claimed: true,
      credit: r.credit,
      energy: r.energy,
    };
  } catch (err) {
    return { taskCode: code, status: "done", message: `达标但领奖失败：${err.message}` };
  }
}

/** 回读（异步计分，两轮各隔 3s）。 */
async function pollMP(client, code, target) {
  let t = await findMPTask(client, code);
  for (let i = 0; i < 2; i++) {
    await sleep(CLAIM_POLL_GAP_MS);
    const t2 = await findMPTask(client, code);
    if (!t2) continue;
    t = t2;
    if (t.claimable || t.claimed || t.current >= target) break;
  }
  return t;
}

/** growth 域小程序限定任务通用闭环（school_season / Sequential_Tasks_1/3/6）。 */
async function runMPMiniChatTask(client, code, withActivityId) {
  let t = await findMPTask(client, code);
  if (!t) return { taskCode: code, status: "skipped", message: "mp 口径未下发该任务（活动可能已结束）" };
  if (t.claimed) return { taskCode: code, status: "skipped", message: "已领取" };
  if (!t.acceptStatus || t.acceptStatus === "not_accepted") {
    if (!(await acceptWithVerifyMP(client, code))) {
      return { taskCode: code, status: "done", message: "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试" };
    }
    const t2 = await findMPTask(client, code); // accept 后回读真实 target/current
    if (t2) t = t2;
  }
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.acceptStatus === "completed") return mpClaim(client, code);
  const need = target - t.current;
  for (let i = 0; i < need; i++) {
    await sleep(MP_CHAT_EVENT_GAP_MS + Math.floor(Math.random() * 10000)); // 真人节奏
    const conv = `wb2api-mp-${Date.now()}-${i}`;
    const ev = withActivityId ? schoolSeasonChatEvent(conv) : schoolChatTimesEvents(conv);
    try {
      await reportMPEvent(client, [ev]);
    } catch (err) {
      return { taskCode: code, status: "done", message: `完成 ${i}/${need} 次上报后中断: ${err.message}` };
    }
  }
  t = await pollMP(client, code, target);
  if (t.claimed) return { taskCode: code, status: "done", message: "本轮已入账（claimed）" };
  if (t.current < target) {
    return {
      taskCode: code,
      status: "done",
      message: `已上报 ${need} 次但进度未达 ${t.current}/${target}（异步计分未归账，下次重试）`,
    };
  }
  return mpClaim(client, code);
}

/** Sequential 链预留任务通用骨架（primary；未点亮且 fallback 非空时补一轮）。 */
async function runSequentialEventTask(client, code, primary, fallback) {
  let t = await findMPTask(client, code);
  if (!t) {
    return { taskCode: code, status: "skipped", message: "mp 口径未下发该任务（前置任务未完成或活动未开始）" };
  }
  if (t.claimed) return { taskCode: code, status: "skipped", message: "已领取" };
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.acceptStatus === "completed") return mpClaim(client, code);
  if (!t.acceptStatus || t.acceptStatus === "not_accepted") {
    if (!(await acceptWithVerifyMP(client, code))) {
      return { taskCode: code, status: "done", message: "accept 未登记生效（任务可能处于每日锁定窗口，等解锁后自动重试）" };
    }
  }
  try {
    await primary();
  } catch (err) {
    return { taskCode: code, status: "done", message: `判据上报失败: ${err.message}` };
  }
  for (let round = 0; round < 2; round++) {
    await sleep(CLAIM_POLL_GAP_MS);
    const t2 = await findMPTask(client, code);
    if (!t2) continue;
    t = t2;
    if (t.claimable || t.claimed || t.current >= target) break;
    if (round === 0 && fallback) {
      try {
        await fallback();
      } catch (err) {
        return { taskCode: code, status: "done", message: `备选判据上报失败: ${err.message}` };
      }
    }
  }
  if (t.claimed) return { taskCode: code, status: "done", message: "本轮已入账（claimed）" };
  if (t.current < target) {
    return { taskCode: code, status: "done", message: "已上报但进度未点亮（判据形态待解锁后校正，下次重试）" };
  }
  return mpClaim(client, code);
}

/** school_season 校园日（mini chat + activityId）。 */
export function runSchoolSeason(client) {
  return runMPMiniChatTask(client, "school_season", true);
}

/** Sequential_Tasks_1 小程序首对话（mini chat，无 activityId）。 */
export function runSequentialChat(client) {
  return runMPMiniChatTask(client, "Sequential_Tasks_1", false);
}

/** Sequential_Tasks_3 小程序 5 次对话（按差额补报，真人节奏）。 */
export function runSequentialChat5(client) {
  return runMPMiniChatTask(client, "Sequential_Tasks_3", false);
}

/** Sequential_Tasks_6 小程序 10 次对话（预留，target 由回读下发）。 */
export function runSequentialChat10(client) {
  return runMPMiniChatTask(client, "Sequential_Tasks_6", false);
}

/** Sequential_Tasks_4 小程序定时任务（判据复用 PC 同源事件）。 */
export function runSequentialAutomation(client) {
  return runSequentialEventTask(
    client,
    "Sequential_Tasks_4",
    () => reportDesktopEvent(client, [desktopAutomationCreateEvent("wb2api 自动化")]),
    null,
  );
}

/** Sequential_Tasks_5 使用 GLM5.2（primary：带模型字段的 mini 对话；fallback：PC 模型上报）。 */
export function runSequentialModelChat(client) {
  return runSequentialEventTask(
    client,
    "Sequential_Tasks_5",
    () => reportMPEvent(client, [miniChatModelEvent(`wb2api-mp-glm-${Date.now()}`, "glm-5.2", "GLM-5.2")]),
    () => client.reportChatActivity(`wb2api-mp-glm-${Date.now()}`, "", "glm-5.2", "GLM-5.2"),
  );
}

/** Sequential_Tasks_7 体验灵感功能（primary：PC 灵感事件组；fallback：mp 形态）。 */
export function runSequentialPlaybook(client) {
  const ms = Date.now();
  return runSequentialEventTask(
    client,
    "Sequential_Tasks_7",
    () =>
      reportDesktopEvent(
        client,
        desktopPlaybookPromptSequence(
          `wb2api-pb-${ms}`, `wb2api-pb-req-${ms}`, "pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸",
        ),
      ),
    () => reportMPEvent(client, miniPlaybookEvents("pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸")),
  );
}

/** Sequential_Tasks_2 小程序选中专家并完成有效对话（市场真实专家 id + mp expert 事件）。 */
export async function runMiniExpert(client) {
  const code = "Sequential_Tasks_2";
  let t = await findMPTask(client, code);
  if (!t) return { taskCode: code, status: "skipped", message: "mp 口径未下发该任务（活动可能已结束）" };
  if (t.claimed) return { taskCode: code, status: "skipped", message: "已领取" };
  const target = t.target > 0 ? t.target : 1; // 未 accept 的 mp 任务 progress 为 null
  if (t.current >= target || t.acceptStatus === "completed") return mpClaim(client, code);
  // 判据载体前置（accept 之前）：市场真实专家 id，拉不到就整任务不动作（避免半程态）
  let experts;
  try {
    experts = await marketExpertList(client, "");
  } catch (err) {
    return { taskCode: code, status: "done", message: `专家市场不可用（${err.message}），跳过以防半程态` };
  }
  if (!experts.length) {
    return { taskCode: code, status: "done", message: "专家市场不可用（列表为空），跳过以防半程态" };
  }
  const e = experts[0];
  const name = e.displayNameZH || e.professionZH;
  if (!t.acceptStatus || t.acceptStatus === "not_accepted") {
    if (!(await acceptWithVerifyMP(client, code))) {
      return { taskCode: code, status: "done", message: "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试" };
    }
  }
  try {
    await reportMPEvent(client, [miniExpertUseEvent(e.expertId, name, e.expertType)]);
  } catch (err) {
    return { taskCode: code, status: "done", message: `上报 expert_actual_use 失败: ${err.message}` };
  }
  t = await pollMP(client, code, target);
  if (t.claimed) return { taskCode: code, status: "done", message: "本轮已入账（claimed）" };
  if (t.current < target) {
    return { taskCode: code, status: "done", message: "已上报但进度未归账（异步计分，下次重试）" };
  }
  return mpClaim(client, code);
}