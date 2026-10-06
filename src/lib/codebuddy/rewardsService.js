// CodeBuddy 激励子系统 —— 9router 侧接线：连接 → 上游客户端、uid 补全、token 持久化、
// 定时调度单例与控制面操作。
// v0.8.0
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { createCodeBuddyClient } from "open-sse/codebuddy/upstream/client.js";
import { resolveCodeBuddyScheduleConfig } from "open-sse/codebuddy/config.js";
import { runCheckinAll, runActivityAll, runTravelAll, runKeepaliveAll } from "open-sse/codebuddy/scheduler.js";
import { completeAllTasks, listAutomationStatus } from "open-sse/codebuddy/orchestrator.js";
import { listAllTasks } from "open-sse/codebuddy/upstream/tasks.js";

const CODEBUDDY_PROVIDERS = ["codebuddy-cn", "codebuddy-intl"];
const log = (m) => console.log(`[CB_REWARDS] ${m}`);

/** 活跃的 CodeBuddy 连接（CN + Intl）。 */
export async function getCodeBuddyConnections() {
  const out = [];
  for (const provider of CODEBUDDY_PROVIDERS) {
    try {
      const conns = await getProviderConnections({ provider, isActive: true });
      out.push(...conns);
    } catch { /* ignore */ }
  }
  return out;
}

function realmFor(conn) {
  if (conn.provider === "codebuddy-intl") return "global";
  const r = conn.providerSpecificData?.realm;
  if (r) return String(r).toLowerCase();
  return "cn";
}

/** 由连接构造上游客户端。 */
export function clientFromConnection(conn, { fetchImpl } = {}) {
  const psd = conn.providerSpecificData || {};
  return createCodeBuddyClient({
    accessToken: conn.accessToken || conn.apiKey || "",
    refreshToken: conn.refreshToken || "",
    uid: psd.uid || "",
    enterpriseId: psd.enterpriseId || "",
    domain: psd.domain || "",
    realm: realmFor(conn),
    deviceToken: psd.deviceToken || "",
    userAgent: psd.userAgent || "",
    fetchImpl,
    proxyOptions: { connectionProxyEnabled: psd.connectionProxyEnabled, connectionProxyUrl: psd.connectionProxyUrl, connectionNoProxy: psd.connectionNoProxy },
  });
}

/** uid 缺失时通过 Web 域 /console/account 补全并落库（一次性）。 */
async function ensureUid(conn, client) {
  if (conn.providerSpecificData?.uid) return client;
  try {
    const profile = await client.fetchAccountProfile();
    if (profile.uid) {
      const psd = { ...(conn.providerSpecificData || {}), uid: profile.uid, ...(profile.nickname ? { nickname: profile.nickname } : {}) };
      await updateProviderConnection(conn.id, { providerSpecificData: psd });
      conn.providerSpecificData = psd;
      log(`uid 补全 ${conn.id.slice(0, 8)} → ${profile.uid}`);
    }
  } catch (err) {
    log(`uid 补全失败 ${conn.id.slice(0, 8)}: ${err?.message || err}`);
  }
  return client;
}

/** 构造全部账号的客户端（含 uid 补全）。 */
export async function buildAllClients({ fetchImpl } = {}) {
  const conns = await getCodeBuddyConnections();
  const pairs = [];
  for (const conn of conns) {
    if (!(conn.accessToken || conn.apiKey)) continue;
    const client = clientFromConnection(conn, { fetchImpl });
    await ensureUid(conn, client);
    pairs.push({ conn, client });
  }
  return pairs;
}

/** 持久化保活刷新后的 token。 */
async function persistRefreshedTokens(pairs, refreshed) {
  const byUid = new Map(refreshed.map((r) => [r.uid, r.tokens]));
  for (const { conn } of pairs) {
    const uid = conn.providerSpecificData?.uid || "";
    const tokens = byUid.get(uid) || byUid.get("");
    if (!tokens) continue;
    const patch = { accessToken: tokens.accessToken };
    if (tokens.refreshToken) patch.refreshToken = tokens.refreshToken;
    if (tokens.expiresIn) patch.expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
    if (tokens.domain) patch.providerSpecificData = { ...(conn.providerSpecificData || {}), domain: tokens.domain };
    await updateProviderConnection(conn.id, patch);
    log(`token 保活已保存 ${conn.id.slice(0, 8)}`);
  }
}

// ── 控制面操作 ─────────────────────────────────────────────────────────────
export async function opCheckin() {
  const pairs = await buildAllClients();
  return runCheckinAll(pairs.map((p) => p.client), { log });
}

export async function opActivity() {
  const cfg = resolveCodeBuddyScheduleConfig();
  const pairs = await buildAllClients();
  return runActivityAll(pairs.map((p) => p.client), { log, accountDelayMs: cfg.accountDelayMs });
}

export async function opTravel() {
  const cfg = resolveCodeBuddyScheduleConfig();
  const pairs = await buildAllClients();
  await runTravelAll(pairs.map((p) => p.client), cfg, { log, adoptTried: adoptTriedToday });
  return { accounts: pairs.length };
}

export async function opKeepalive() {
  const pairs = await buildAllClients();
  const refreshed = await runKeepaliveAll(pairs.map((p) => p.client), { log });
  await persistRefreshedTokens(pairs, refreshed);
  return { refreshed: refreshed.length };
}

/** 单账号一键完成全部成长任务。 */
export async function opCompleteTasks(connectionId, opts = {}) {
  const conns = await getCodeBuddyConnections();
  const conn = connectionId ? conns.find((c) => c.id === connectionId) : conns[0];
  if (!conn) return { error: "no codebuddy connection" };
  const client = await ensureUid(conn, clientFromConnection(conn));
  return completeAllTasks(client, { log, ...opts });
}

/** 单账号任务列表（含可自动化标记）。 */
export async function opListTasks(connectionId) {
  const conns = await getCodeBuddyConnections();
  const conn = connectionId ? conns.find((c) => c.id === connectionId) : conns[0];
  if (!conn) return { error: "no codebuddy connection" };
  const client = await ensureUid(conn, clientFromConnection(conn));
  const { tasks, autoCodes } = await listAutomationStatus(client);
  return { tasks, autoCodes };
}

export async function opAllAccountsSummary() {
  const pairs = await buildAllClients();
  const accounts = [];
  for (const { conn, client } of pairs) {
    try {
      const tasks = await listAllTasks(client);
      accounts.push({
        id: conn.id,
        uid: conn.providerSpecificData?.uid || "",
        nickname: conn.providerSpecificData?.nickname || conn.displayName || "",
        provider: conn.provider,
        realm: realmFor(conn),
        tasks: tasks.length,
        claimable: tasks.filter((t) => t.claimable).length,
      });
    } catch (err) {
      accounts.push({ id: conn.id, provider: conn.provider, error: err?.message || String(err) });
    }
  }
  return { accounts };
}

// ── 定时调度单例 ───────────────────────────────────────────────────────────
const g = (global.__cbRewards ??= { timer: null, fired: new Set(), adoptTried: new Set() });
const adoptTriedToday = g.adoptTried;

/** 小时制排程：整点触发一次，同一「日期+类型+小时」只跑一次（进程内去重）。 */
function shouldFire(kind, hour, now) {
  const key = `${now.toISOString().slice(0, 10)}:${kind}:${hour}`;
  if (g.fired.has(key)) return false;
  // 清理旧键，避免集合无限增长
  if (g.fired.size > 200) g.fired.clear();
  g.fired.add(key);
  return true;
}

function tick() {
  const cfg = resolveCodeBuddyScheduleConfig();
  if (!cfg.enabled) return;
  const now = new Date();
  const hour = now.getHours();
  if (cfg.checkinHours.includes(hour) && shouldFire("checkin", hour, now)) {
    opCheckin().catch((e) => log(`checkin 批量失败: ${e?.message || e}`));
  }
  if (cfg.activityHours.includes(hour) && shouldFire("activity", hour, now)) {
    opActivity().catch((e) => log(`activity 批量失败: ${e?.message || e}`));
  }
  if (cfg.travelHours.includes(hour) && shouldFire("travel", hour, now)) {
    opTravel().catch((e) => log(`travel 批量失败: ${e?.message || e}`));
  }
  if (cfg.keepaliveHours.includes(hour) && shouldFire("keepalive", hour, now)) {
    opKeepalive().catch((e) => log(`keepalive 批量失败: ${e?.message || e}`));
  }
  if (cfg.growthHours.includes(hour) && shouldFire("growth", hour, now)) {
    opCompleteTasksAll().catch((e) => log(`growth 批量失败: ${e?.message || e}`));
  }
}

/** 对全部账号跑一键完成（成长任务队列）。 */
export async function opCompleteTasksAll() {
  const pairs = await buildAllClients();
  const out = [];
  for (const { conn, client } of pairs) {
    try {
      out.push({ id: conn.id, ...(await completeAllTasks(client, { log })) });
    } catch (err) {
      out.push({ id: conn.id, error: err?.message || String(err) });
    }
  }
  return { accounts: out };
}

export function startCodeBuddyRewardsScheduler() {
  if (g.timer) return { started: false, status: "running" };
  const cfg = resolveCodeBuddyScheduleConfig();
  if (!cfg.enabled) return { started: false, status: "disabled" };
  g.timer = setInterval(tick, 60_000);
  if (g.timer.unref) g.timer.unref();
  // 启动即对齐一次（避免刚好跨过整点错过）
  tick();
  log(`定时调度已启动 · 签到${cfg.checkinHours} 活跃${cfg.activityHours} 旅行${cfg.travelHours} 保活${cfg.keepaliveHours} 任务${cfg.growthHours}`);
  return { started: true, status: "running" };
}

export function stopCodeBuddyRewardsScheduler() {
  if (g.timer) {
    clearInterval(g.timer);
    g.timer = null;
  }
  return { status: "stopped" };
}

export function codeBuddyRewardsSchedulerStatus() {
  return { status: g.timer ? "running" : "stopped", enabled: resolveCodeBuddyScheduleConfig().enabled };
}