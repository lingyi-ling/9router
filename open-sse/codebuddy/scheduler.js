// CodeBuddy 激励定时任务：签到（含连登闭环）/ 活跃上报 / 猫猫旅行 / token 保活 / 成长任务队列。
// 移植自 workbuddy2api-panel internal/scheduler/{scheduler,travel}.go 的流程语义。
//
// 与 Go 的差异（9router 适配）：
//   - 不存在「账号池」；由调用方传入账号（client）列表，池调度/选号/熔断仍由 9router 自身负责。
//   - token 保活刷新成功后返回新 token，由上层持久化到连接（Go 里直接写 auth 文件）。
//   - 全程 fail-open：单账号失败只记日志，不中断整批。
// v0.8.0
import { isAlreadyCheckin, isBuddyTaskIncomplete } from "./upstream/client.js";
import { growthStreak, travelStatus, travelDepart, travelClaim, buddyInfo, buddyFirst, buddyAgreement } from "./upstream/travel.js";
import { growthStreakFull, runStreakLoop } from "./upstream/streak.js";
import { TRAVEL_STATE } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function label(client) {
  return client?.credential?.uid || client?.credential?.nickname || "account";
}

/** 该账号是否参与 CN 任务体系（global 账号无签到/旅行体系）。 */
function isGlobalClient(client) {
  return client?.isGlobal === true;
}

/**
 * 签到（全部账号）+ 末尾连登闭环（兑换档位 + 抽奖）。
 * @returns {Promise<{ok:number, already:number, failed:number, streak:object}>}
 */
export async function runCheckinAll(clients, { log = () => {} } = {}) {
  let ok = 0, already = 0, failed = 0;
  for (const client of clients) {
    if (isGlobalClient(client)) continue; // D4 门控：global 无签到体系
    try {
      await client.dailyCheckin();
      ok++;
      log(`checkin ${label(client)}: 签到成功`);
    } catch (err) {
      if (isAlreadyCheckin(err)) {
        already++;
        log(`checkin ${label(client)}: 今天已签到（幂等）`);
      } else {
        failed++;
        log(`checkin ${label(client)}: ${err?.message || err}`);
      }
    }
    // 余额刷新（保持积分观测量新鲜；失败不影响签到）
    try {
      await client.fetchBalance();
    } catch { /* fail-open */ }
  }
  const streak = await runStreakBonusAll(clients, { log });
  return { ok, already, failed, streak };
}

/** 连登闭环：对每个 CN 账号兑换已解锁档位 + 抽完抽奖次数。 */
export async function runStreakBonusAll(clients, { log = () => {} } = {}) {
  const summary = {};
  for (const client of clients) {
    if (isGlobalClient(client)) continue;
    try {
      const full = await growthStreakFull(client);
      const res = await runStreakLoop(client, full);
      if (res.redeemed.length || res.drawn) {
        log(`streak ${label(client)}: 兑换[${res.redeemed.join(",")}] 抽奖${res.drawn}次`);
      }
      summary[label(client)] = res;
    } catch (err) {
      log(`streak ${label(client)}: ${err?.message || err}`);
    }
  }
  return summary;
}

/**
 * 活跃上报（每号一条 chat_request_send；点亮连登 + 解锁 first_buddy）。
 * 上报成功后回读 streak 自检（days==0 = 服务端静默丢弃，需告警）。
 */
export async function runActivityAll(clients, { log = () => {}, accountDelayMs = 1200 } = {}) {
  let ok = 0, failed = 0, suspicious = 0;
  let first = true;
  for (const client of clients) {
    if (!first && accountDelayMs > 0) await sleep(accountDelayMs);
    first = false;
    const cid = `wb2api-${Date.now()}`;
    try {
      await client.reportChatActivity(cid, "");
      ok++;
      // 回读连登天数自检（只读 oracle，不重试）
      try {
        const days = await growthStreak(client);
        if (days === 0) {
          suspicious++;
          log(`activity ${label(client)}: report OK but streak.days=0 (silent drop?)`);
        } else {
          log(`activity ${label(client)}: streak days=${days}`);
        }
      } catch (err) {
        suspicious++;
        log(`activity ${label(client)}: streak check failed (report OK): ${err?.message || err}`);
      }
    } catch (err) {
      failed++;
      log(`activity ${label(client)}: ${err?.message || err}`);
    }
  }
  return { ok, failed, suspicious };
}

/** 猫猫旅行：单账号状态机（最多一个动作）。无猫时先跑领养链路。 */
export async function travelOne(client, cfg, { log = () => {}, adoptTried = new Set() } = {}) {
  let buddy;
  try {
    buddy = await buddyInfo(client);
  } catch (err) {
    log(`travel ${label(client)}: buddy-info: ${err?.message || err}`);
    return;
  }
  if (!buddy) {
    const uid = label(client);
    if (adoptTried.has(uid)) return;
    // 前置：report（解锁 first_buddy）→ agreement → buddy/first
    try {
      await client.reportChatActivity(`wb2api-adopt-${Date.now()}`, "");
      if (cfg.adoptReportGapMs > 0) await sleep(cfg.adoptReportGapMs);
    } catch (err) {
      log(`travel ${label(client)}: adopt preflight report: ${err?.message || err}`);
    }
    try {
      await buddyAgreement(client);
    } catch (err) {
      log(`travel ${label(client)}: agreement: ${err?.message || err}`);
      return;
    }
    const res = await buddyFirst(client);
    if (res.ok) log(`travel ${label(client)}: adopt ok (+300 credits)`);
    else {
      adoptTried.add(uid);
      log(`travel ${label(client)}: adopt skipped (conversation threshold not reached, retry tomorrow)`);
    }
    return;
  }
  let ts;
  try {
    ts = await travelStatus(client);
  } catch (err) {
    log(`travel ${label(client)}: status: ${err?.message || err}`);
    return;
  }
  if (ts.state === TRAVEL_STATE.ARRIVED) {
    if (!ts.recordId) {
      log(`travel ${label(client)}: claim skipped (arrived but no record_id)`);
      return;
    }
    try {
      const reward = await travelClaim(client, ts.recordId);
      log(`travel ${label(client)}: claim ok record=${ts.recordId} reward=${reward}`);
    } catch (err) {
      log(`travel ${label(client)}: claim record=${ts.recordId}: ${err?.message || err}`);
    }
  } else if (ts.state === TRAVEL_STATE.IDLE) {
    if (ts.dailyLimitReached) {
      log(`travel ${label(client)}: skip (daily limit reached)`);
      return;
    }
    try {
      await travelDepart(client, cfg.travelLocationId);
      log(`travel ${label(client)}: depart ok location=${cfg.travelLocationId}`);
    } catch (err) {
      log(`travel ${label(client)}: depart: ${err?.message || err}`);
    }
  } else {
    log(`travel ${label(client)}: skip (${ts.state || "unknown"})`);
  }
}

/** 猫猫旅行（全部账号）。 */
export async function runTravelAll(clients, cfg, { log = () => {}, adoptTried = new Set() } = {}) {
  let first = true;
  for (const client of clients) {
    if (isGlobalClient(client)) continue; // D4 门控
    if (!first && cfg.accountDelayMs > 0) await sleep(cfg.accountDelayMs);
    first = false;
    try {
      await travelOne(client, cfg, { log, adoptTried });
    } catch (err) {
      log(`travel ${label(client)}: ${err?.message || err}`);
    }
  }
}

/**
 * token 保活：刷新 access token。
 * @returns {Promise<Array<{uid:string, tokens:object}>>} 刷新成功的账号（上层持久化）
 */
export async function runKeepaliveAll(clients, { log = () => {} } = {}) {
  const refreshed = [];
  for (const client of clients) {
    if (!client?.credential?.refreshToken) continue;
    try {
      const tokens = await client.refreshToken();
      refreshed.push({ uid: client.credential.uid || "", tokens });
    } catch (err) {
      log(`keepalive ${label(client)}: ${err?.message || err}`);
    }
  }
  return refreshed;
}