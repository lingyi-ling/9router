// CodeBuddy 成长中心「连登兑换 + 抽奖」接口。
// 移植自 workbuddy2api-panel internal/upstream/streak.go。
//
// 连登档位（7d/14d/28d）按连续登录天数解锁；兑换发 credit/energy/补签卡/抽奖次数；
// 抽奖每次消耗 1 次 chances。未解锁兑换返回 403（连续登录天数不足）→ 按 locked 跳过。
import { clientToken } from "./client.js";

const REDEEM_PATH = "/activity/growth/redeem";
const LOTTERY_SUMMARY_PATH = "/activity/growth/lottery/summary";
const LOTTERY_DRAW_PATH = "/activity/growth/lottery/draw";

const TIERS = ["7d", "14d", "28d"];

/** 当前抽奖次数。 */
export async function lotteryChances(client) {
  const d = await client.growthJSON("GET", LOTTERY_SUMMARY_PATH);
  return { chances: Number(d?.chances) || 0, enabled: Boolean(d?.module?.enabled) };
}

/** 抽奖一次，返回原始奖品载荷（形状随活动期变化，透传）。 */
export async function lotteryDraw(client) {
  return client.growthJSON("POST", LOTTERY_DRAW_PATH, { client_token: clientToken() });
}

/** 兑换连登档位；未解锁（403）返回 {ok:false, locked:true}。 */
export async function redeemTier(client, tier) {
  try {
    await client.growthJSON("POST", REDEEM_PATH, { tier, client_token: clientToken() });
    return { ok: true };
  } catch (err) {
    if (err?.status === 403) return { ok: false, locked: true };
    throw err;
  }
}

/**
 * 连登闭环：兑换已解锁档位 + 抽完抽奖次数。
 * 挂在签到排程末尾（幂等：已兑换/无次数时为空操作）。
 * @param {object} client
 * @param {{redemption:object}} streakFull - growthStreakFull() 的结果
 * @returns {Promise<{redeemed:string[], locked:string[], drawn:number, prizes:any[]}>}
 */
export async function runStreakLoop(client, streakFull) {
  const redeemed = [];
  const locked = [];
  for (const tier of TIERS) {
    const statusKey = `tier${tier.replace("d", "")}dStatus`;
    const status = streakFull?.redemption?.[statusKey];
    // 仅未兑换（非 redeemed/claimed）的档位尝试；锁定档位由 403 兜底。
    if (status && /redeem|claim/i.test(status)) continue;
    const res = await redeemTier(client, tier);
    if (res.ok) redeemed.push(tier);
    else if (res.locked) locked.push(tier);
  }

  let drawn = 0;
  const prizes = [];
  const { chances } = await lotteryChances(client);
  for (let i = 0; i < chances; i++) {
    try {
      prizes.push(await lotteryDraw(client));
      drawn++;
    } catch {
      break; // 次数用尽/活动关闭 → 停止
    }
  }
  return { redeemed, locked, drawn, prizes };
}

export const STREAK_PATHS = {
  redeem: REDEEM_PATH,
  lotterySummary: LOTTERY_SUMMARY_PATH,
  lotteryDraw: LOTTERY_DRAW_PATH,
  tiers: TIERS,
};