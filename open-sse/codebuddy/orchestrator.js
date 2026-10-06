// CodeBuddy 成长任务「一键完成」编排。
// 移植自 workbuddy2api-panel internal/panel/{tasks,autotask}.go 的扫描→报名→执行→领奖管线。
//
// 管线：listAllTasks → accept（幂等报名）→ 逐个执行事件链 runner → 复扫进度 → claim 达标项。
// 行为事件按天幂等：重复执行不会重复扣资源，已达标任务自动跳过。
// v0.8.0
import { listAllTasks, acceptTasks, acceptTasksMP, claimReward, claimRewardMP } from "./upstream/tasks.js";

// 小程序口径专属任务（accept/claim 需 X-Client-Platform: miniprogram）。
const MP_ONLY_CODES = new Set(["school_season", "Sequential_Tasks_1"]);

/** 动态加载桌面事件链注册表（未移植时返回空，编排降级为「仅报名 + 领奖」）。 */
async function loadRunners() {
  try {
    const mod = await import("./upstream/desktop.js");
    return { runners: mod.DESKTOP_TASK_RUNNERS || {}, codes: mod.AUTO_TASK_CODES || [] };
  } catch {
    return { runners: {}, codes: [] };
  }
}

function isClaimed(t) {
  return t.claimed === true;
}

/**
 * 一键完成全部可自动化任务。
 * @param {object} client
 * @param {{log?:Function, onProgress?:Function, only?:string[]}} [opts]
 * @returns {Promise<object>} 汇总（accepted/executed/claimed/credit/energy/skipped）
 */
export async function completeAllTasks(client, opts = {}) {
  const log = opts.log || (() => {});
  const { runners, codes } = await loadRunners();
  const result = { accepted: [], executed: [], claimed: [], credit: 0, energy: 0, skipped: [], errors: [] };

  let tasks;
  try {
    tasks = await listAllTasks(client);
  } catch (err) {
    result.errors.push(`list: ${err?.message || err}`);
    return result;
  }

  const wanted = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  const target = tasks.filter((t) => !isClaimed(t) && (!wanted || wanted.has(t.taskCode)));

  // 1) 报名（幂等）：默认口径 + 小程序口径分别 accept。
  const normalCodes = target.filter((t) => !MP_ONLY_CODES.has(t.taskCode)).map((t) => t.taskCode);
  const mpCodes = target.filter((t) => MP_ONLY_CODES.has(t.taskCode)).map((t) => t.taskCode);
  try {
    if (normalCodes.length) {
      await acceptTasks(client, normalCodes);
      result.accepted.push(...normalCodes);
    }
  } catch (err) {
    result.errors.push(`accept: ${err?.message || err}`);
  }
  try {
    if (mpCodes.length) {
      await acceptTasksMP(client, mpCodes);
      result.accepted.push(...mpCodes);
    }
  } catch (err) {
    result.errors.push(`accept(mp): ${err?.message || err}`);
  }

  // 2) 执行事件链 runner（只跑已注册、且出现在当前任务列表里的）。
  const executable = codes.filter((c) => target.some((t) => t.taskCode === c));
  for (const code of executable) {
    const runner = runners[code];
    if (typeof runner !== "function") {
      result.skipped.push(code);
      continue;
    }
    try {
      await runner(client);
      result.executed.push(code);
      log(`task ${code}: executed`);
      opts.onProgress?.({ phase: "executed", code });
    } catch (err) {
      result.errors.push(`${code}: ${err?.message || err}`);
      log(`task ${code}: ${err?.message || err}`);
    }
  }

  // 3) 复扫进度并领奖（异步计分需要落定时间；此处只扫一次，未达标留待下次）。
  let after;
  try {
    after = await listAllTasks(client);
  } catch (err) {
    result.errors.push(`relist: ${err?.message || err}`);
    return result;
  }
  for (const t of after) {
    if (!t.claimable || isClaimed(t)) continue;
    if (wanted && !wanted.has(t.taskCode)) continue;
    try {
      const res = MP_ONLY_CODES.has(t.taskCode) ? await claimRewardMP(client, t.taskCode) : await claimReward(client, t.taskCode);
      if (!res.alreadyClaimed) {
        result.credit += res.credit;
        result.energy += res.energy;
      }
      result.claimed.push(t.taskCode);
      log(`task ${t.taskCode}: claimed +${res.credit}c +${res.energy}e`);
      opts.onProgress?.({ phase: "claimed", code: t.taskCode, credit: res.credit, energy: res.energy });
    } catch (err) {
      result.errors.push(`claim ${t.taskCode}: ${err?.message || err}`);
    }
  }

  return result;
}

/** 列出可自动化任务（供面板展示待办）。 */
export async function listAutomationStatus(client) {
  const { codes } = await loadRunners();
  const tasks = await listAllTasks(client);
  return { tasks, autoCodes: codes };
}