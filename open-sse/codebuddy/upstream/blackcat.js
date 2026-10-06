// CodeBuddy 夜猫子任务（black_cat）+ 新手礼包 / 补偿 / 补签。
// 移植自 workbuddy2api-panel internal/upstream/blackcat.go。
//
// v0.8.0 判据：black_cat 要求在 **23:00–08:00（本地时区）窗口内**完成 3 次 glm-5.2
// 真实对话并上报 chat 事件链；窗口外行为不计分。对话内容极短（1+1），消耗可忽略。
// 本模块自包含（不依赖 desktop.js），以实现注册表单向依赖（desktop → blackcat）。
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { listAllTasks, claimReward } from "./tasks.js";

const CHAT_PATH = "/v2/chat/completions";
const CLAIM_POLL_ATTEMPTS = 4;
const CLAIM_POLL_GAP_MS = 3000;
const NIGHT_CHAT_GAP_MS = 4000; // Go RunNightChats 每条间隔 4s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 当前是否处于夜猫子计数窗口（23:00–08:00 本地时区）。
 * @param {Date} [now]
 * @returns {boolean}
 */
export function inNightWindow(now = new Date()) {
  const h = now.getHours();
  return h >= 23 || h < 8;
}

/** 发一次 glm-5.2 真实对话并读干 SSE 流（上游强制 flow：不读完会残留连接）。 */
async function nightChat(client, model) {
  const body = {
    model,
    messages: [{ role: "user", content: "1+1等于几？直接回答。" }],
    stream: true,
  };
  const headers = { ...client.billingHeaders(), Accept: "application/json, text/event-stream" };
  const resp = await proxyAwareFetch(`${client.chatBase()}${CHAT_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.CODEBUDDY_TIMEOUT_MS || 15_000)),
  });
  if (resp.status >= 400) {
    const raw = await resp.text().catch(() => "");
    throw new Error(`http=${resp.status} body=${raw.slice(0, 120)}`);
  }
  await resp.text().catch(() => "");
}

/**
 * black_cat 剩余差额（需要再完成几次对话）。任务不存在返回 0。
 * @param {object} client
 * @returns {Promise<number>}
 */
export async function blackcatNeed(client) {
  const tasks = await listAllTasks(client);
  const t = tasks.find((x) => x.taskCode === "black_cat");
  if (!t) return 0;
  if (t.claimed || t.current >= t.target) return 0;
  return t.target - t.current;
}

/**
 * 发 need 次 glm-5.2 真实对话并上报事件链。
 * @returns {Promise<{ok:number, error?:string}>}
 */
export async function runNightChats(client, need) {
  let ok = 0;
  for (let i = 0; i < need; i++) {
    try {
      await nightChat(client, "glm-5.2");
    } catch (err) {
      return { ok, error: `第 ${i + 1} 次对话失败: ${err.message}` };
    }
    try {
      await client.reportChatActivity(`wb2api-night-${Date.now()}-${i}`, "", "glm-5.2", "GLM-5.2");
    } catch (err) {
      return { ok, error: `第 ${i + 1} 次上报失败: ${err.message}` };
    }
    ok++;
    await sleep(NIGHT_CHAT_GAP_MS);
  }
  return { ok };
}

/**
 * black_cat 一键完成：窗口内补足真实对话并（达标时）领奖。
 * @param {object} client
 * @returns {Promise<object>} 结果对象
 */
export async function runBlackCat(client) {
  if (!inNightWindow()) {
    return {
      taskCode: "black_cat",
      status: "skipped",
      message: "当前不在 23:00–08:00 计数窗口，行为不计分；网关会在每日 23 点自动补足",
    };
  }
  const need = await blackcatNeed(client);
  if (need <= 0) return { taskCode: "black_cat", status: "done", message: "进度已达标，无需补足" };
  const { ok, error } = await runNightChats(client, need);
  if (error) return { taskCode: "black_cat", status: "done", message: `完成 ${ok}/${need} 次后中断: ${error}` };
  // 回读（异步计分）+ 达标领奖
  let t = (await listAllTasks(client).catch(() => [])).find((x) => x.taskCode === "black_cat") || null;
  for (let i = 1; i < CLAIM_POLL_ATTEMPTS && t && !t.claimable && !t.claimed; i++) {
    await sleep(CLAIM_POLL_GAP_MS);
    const t2 = (await listAllTasks(client).catch(() => [])).find((x) => x.taskCode === "black_cat");
    if (t2) t = t2;
  }
  const out = { taskCode: "black_cat", status: "done", message: `已完成 ${ok} 次夜间对话并上报` };
  if (t && t.claimable) {
    try {
      const r = await claimReward(client, "black_cat");
      out.claimed = true;
      out.credit = r.credit;
      out.energy = r.energy;
      if (r.credit > 0 || r.energy > 0) out.message += `；已自动领奖 +${r.credit} 分 +${r.energy} 能`;
    } catch (err) {
      out.claimError = err.message;
    }
  }
  return out;
}

/** 领取新手礼包（每号一次；已领返回业务错误）。返回 credit。 */
export async function claimGift(client) {
  const data = await client.billingJSON("POST", "/billing/meter/claim-gift", {});
  return Number(data?.credit) || 0;
}

/** 领取活动补偿（有则领，无则业务错误）。返回 credit。 */
export async function claimCompensation(client) {
  const data = await client.billingJSON("POST", "/billing/meter/claim-compensation", {});
  return Number(data?.credit) || 0;
}

/** 检查昨日是否漏签（heatmap cell score==0）。 */
export async function heatmapYesterdayMissed(client) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  const data = await client.growthJSON("GET", "/activity/growth/heatmap");
  const cells = Array.isArray(data?.cells) ? data.cells : [];
  const cell = cells.find((c) => typeof c?.date === "string" && c.date.slice(0, 10) === yesterday);
  return cell ? Number(cell.score) === 0 : false;
}

/** 对指定日期使用补签卡（无卡返回业务错误）。 */
export async function useMakeupCard(client, date) {
  await client.growthJSON("POST", "/activity/growth/makeup-cards/use", { target_date: date });
}