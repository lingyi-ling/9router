// CodeBuddy growth 域「猫猫旅行 / 领养 / 连登」接口。
// 移植自 workbuddy2api-panel internal/upstream/travel.go。
//
// 全部走 chatBase（copilot.tencent.com，无 /v2 前缀）+ billing 头族。
import { isBuddyTaskIncomplete } from "./client.js";

const TRAVEL_STATUS_PATH = "/activity/growth/buddy/travel/status";
const TRAVEL_DEPART_PATH = "/activity/growth/buddy/travel/depart";
const TRAVEL_CLAIM_PATH = "/activity/growth/buddy/travel/claim";
const BUDDY_INFO_PATH = "/activity/growth/buddy/info";
const BUDDY_FIRST_PATH = "/activity/growth/buddy/first";
const BUDDY_AGREEMENT_PATH = "/activity/growth/buddy/agreement";
const STREAK_PATH = "/activity/growth/streak";

/** 猫猫旅行状态：state=idle|traveling|arrived。 */
export async function travelStatus(client) {
  const d = await client.growthJSON("GET", TRAVEL_STATUS_PATH);
  return {
    state: d?.state || "",
    dailyLimitReached: Boolean(d?.daily_limit_reached),
    recordId: Number(d?.record_id) || 0,
    rewardCredit: Number(d?.reward_credit) || 0,
  };
}

/** 派出旅行；locationId 实测 1~4（收益/时长区间相同）。 */
export async function travelDepart(client, locationId = 1) {
  await client.growthJSON("POST", TRAVEL_DEPART_PATH, { location_id: locationId });
}

/** 领取到站奖励，返回 reward_credit。 */
export async function travelClaim(client, recordId) {
  const d = await client.growthJSON("POST", TRAVEL_CLAIM_PATH, { record_id: recordId });
  return Number(d?.reward_credit) || 0;
}

/** 当前猫档案；(null) 表示无猫。 */
export async function buddyInfo(client) {
  const d = await client.growthJSON("GET", BUDDY_INFO_PATH);
  const buddy = d?.buddy;
  if (!buddy || typeof buddy !== "object") return null;
  return { id: Number(buddy.id) || 0, name: buddy.name || "" };
}

/**
 * 领养第一只猫。门槛未达标返回 400（first_buddy task not completed yet），
 * 属预期行为，调用方静默跳过（当日不重试）。
 * @returns {Promise<{ok:boolean, skipped?:string}>}
 */
export async function buddyFirst(client) {
  try {
    await client.growthJSON("POST", BUDDY_FIRST_PATH, {});
    return { ok: true };
  } catch (err) {
    if (isBuddyTaskIncomplete(err)) return { ok: false, skipped: "task_incomplete" };
    throw err;
  }
}

/** 同意协议（幂等）。 */
export async function buddyAgreement(client) {
  await client.growthJSON("POST", BUDDY_AGREEMENT_PATH, { agree: true });
}

/** 连登天数（只读 oracle；days==0 表示上报 200 但被静默丢弃）。 */
export async function growthStreak(client) {
  const d = await client.growthJSON("GET", STREAK_PATH);
  return Number(d?.streak?.days) || 0;
}

/** 连登完整状态（档位/补签卡/兑换状态）。 */
export async function growthStreakFull(client) {
  const d = await client.growthJSON("GET", STREAK_PATH);
  return {
    days: Number(d?.streak?.days) || 0,
    monthTotalDays: Number(d?.streak?.month_total_days) || 0,
    nextTier: d?.streak?.next_tier || "",
    nextTierRemaining: Number(d?.streak?.next_tier_remaining) || 0,
    makeupCards: {
      balance: Number(d?.makeup_cards?.balance) || 0,
      max: Number(d?.makeup_cards?.max) || 0,
    },
    redemption: {
      tier7dStatus: d?.redemption_status?.tier_7d_status || "",
      tier14dStatus: d?.redemption_status?.tier_14d_status || "",
      tier28dStatus: d?.redemption_status?.tier_28d_status || "",
      remainingDays: Number(d?.redemption_status?.remaining_days) || 0,
      tiers: Array.isArray(d?.redemption_status?.tiers) ? d.redemption_status.tiers : [],
    },
  };
}

export const TRAVEL_PATHS = {
  status: TRAVEL_STATUS_PATH,
  depart: TRAVEL_DEPART_PATH,
  claim: TRAVEL_CLAIM_PATH,
  streak: STREAK_PATH,
};