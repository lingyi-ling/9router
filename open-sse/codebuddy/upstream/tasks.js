// CodeBuddy growth 域「任务」接口：列表 / 接受 / 领奖。
// 移植自 workbuddy2api-panel internal/upstream/tasks.go。
//
// 端点（chatBase，billing 头族）：
//   GET  /v2/activity/growth/tasks                全量任务列表（默认口径）
//   GET  /v2/activity/growth/tasks                + X-Client-Platform: miniprogram（小程序口径超集）
//   POST /v2/activity/growth/tasks/accept         {"task_codes":[...]} 报名（不产生进度）
//   POST /activity/growth/tasks/{code}/claim      chat 域领奖（无 body）
//   POST {webBase}/activity/growth/tasks/{code}/claim  Web 域领奖（chat 域 400 时降级）
//
// accept 是「报名」；进度由服务端行为事件点亮；claim 仅在进度达标后可领（重复领幂等）。
import { CodeBuddyError, CB_ERROR_KIND } from "./client.js";

const TASKS_LIST_PATH = "/v2/activity/growth/tasks";
const TASKS_ACCEPT_PATH = "/v2/activity/growth/tasks/accept";
const MP_PLATFORM = "miniprogram";

/** 宽松解析任务列表 data.tasks[]（progress 可能是对象或平铺字段）。 */
export function parseGrowthTasks(data) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  return tasks.map((t) => {
    let current = Number(t.current) || 0;
    let target = Number(t.target) || 0;
    const pr = t.progress;
    if (pr && typeof pr === "object") {
      const pc = Number(pr.current) || 0;
      const pt = Number(pr.target) || 0;
      if (pt > 0 || pc > 0) {
        current = pc;
        target = pt;
      }
    }
    const claimed = t.accept_status === "claimed";
    return {
      taskCode: t.task_code,
      title: t.title || "",
      description: t.description || "",
      taskDesc: t.task_desc || "",
      credit: Number(t.reward_credit) || 0,
      energy: Number(t.reward_energy) || 0,
      hasReward: Boolean(t.has_reward),
      rewardBuddy: Boolean(t.reward_buddy),
      taskType: t.task_type || "",
      tag: t.tag || "",
      jumpUrl: t.jump_url || "",
      locked: Boolean(t.locked),
      target,
      current,
      acceptStatus: t.accept_status || "",
      status: t.status || "",
      claimable: !claimed && target > 0 && current >= target,
      claimed,
    };
  });
}

/** 拉取默认口径任务列表。 */
export async function listTasks(client) {
  const data = await client.growthJSON("GET", TASKS_LIST_PATH);
  return parseGrowthTasks(data);
}

/** 拉取小程序口径任务列表（默认口径的超集，含 mp 专属任务）。 */
export async function listTasksMP(client) {
  const data = await client.growthJSONMP("GET", TASKS_LIST_PATH);
  return parseGrowthTasks(data);
}

/** 合并默认 + 小程序两个口径，按 task_code 去重。 */
export async function listAllTasks(client) {
  const [normal, mp] = await Promise.all([
    listTasks(client).catch(() => []),
    listTasksMP(client).catch(() => []),
  ]);
  const byCode = new Map();
  for (const t of [...normal, ...mp]) {
    if (!byCode.has(t.taskCode)) byCode.set(t.taskCode, t);
  }
  return [...byCode.values()];
}

/** 接受（报名）任务；幂等。 */
export async function acceptTasks(client, taskCodes) {
  await client.growthJSON("POST", TASKS_ACCEPT_PATH, { task_codes: taskCodes });
}

/** 接受小程序限定任务（缺 mp 头会 task not found）。 */
export async function acceptTasksMP(client, taskCodes) {
  await client.growthJSONMP("POST", TASKS_ACCEPT_PATH, { task_codes: taskCodes });
}

function parseClaim(data) {
  return {
    alreadyClaimed: Boolean(data?.already_claimed),
    credit: Number(data?.credit) || 0,
    energy: Number(data?.energy) || 0,
  };
}

/** chat 域领奖；400 时降级 Web 域。 */
export async function claimRewardMP(client, taskCode) {
  try {
    const data = await client.growthJSONMP("POST", `/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`);
    return parseClaim(data);
  } catch (err) {
    if (err instanceof CodeBuddyError && err.status === 400) return claimReward(client, taskCode);
    throw err;
  }
}

/** Web 域领奖（成长中心；task_code 在路径、无 body）。 */
export async function claimReward(client, taskCode) {
  const data = await client.doJSON(`${client.webBase()}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, {
    method: "POST",
    headers: client.webHeaders(),
  });
  return parseClaim(data);
}

/** 领奖并归一化错误（not_found 等按未达标处理）。 */
export async function claimIfReady(client, taskCode, { mp = false } = {}) {
  try {
    return mp ? await claimRewardMP(client, taskCode) : await claimReward(client, taskCode);
  } catch (err) {
    if (err instanceof CodeBuddyError && err.kind === CB_ERROR_KIND.NOT_FOUND) {
      return { alreadyClaimed: false, credit: 0, energy: 0, skipped: "not_found" };
    }
    throw err;
  }
}