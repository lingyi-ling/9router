// CodeBuddy 激励子系统运行时配置（env 驱动，默认对齐 workbuddy2api-panel）。
// v0.8.0

function intList(raw, fallback) {
  if (!raw) return fallback;
  const parts = String(raw).split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  return parts.length ? parts : fallback;
}

function num(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 排程时点（本地时区整点），默认与 Go 版一致。 */
export function resolveCodeBuddyScheduleConfig() {
  return {
    enabled: process.env.CODEBUDDY_REWARDS_ENABLED !== "0",
    checkinHours: intList(process.env.CODEBUDDY_CHECKIN_HOURS, [9, 21]),
    travelHours: intList(process.env.CODEBUDDY_TRAVEL_HOURS, [9, 21]),
    activityHours: intList(process.env.CODEBUDDY_ACTIVITY_HOURS, [10]),
    keepaliveHours: intList(process.env.CODEBUDDY_KEEPALIVE_HOURS, [22]),
    growthHours: intList(process.env.CODEBUDDY_GROWTH_HOURS, [1]),
    // 账号间限速（防对上游风控）
    accountDelayMs: num(process.env.CODEBUDDY_ACCOUNT_DELAY_MS, 1200),
    // 签到成功后给上游事件处理留的间隔（领养前置 report 用）
    adoptReportGapMs: num(process.env.CODEBUDDY_ADOPT_GAP_MS, 1050),
    // 旅行派出地点（1~4）
    travelLocationId: num(process.env.CODEBUDDY_TRAVEL_LOCATION_ID, 1),
    autostart: process.env.CODEBUDDY_REWARDS_AUTOSTART === "1",
  };
}

export const TRAVEL_STATE = { IDLE: "idle", TRAVELING: "traveling", ARRIVED: "arrived" };