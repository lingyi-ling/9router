"use client";

// CodeBuddy 激励中心：账号总览 + 一键操作（签到/活跃/旅行/保活/一键完成任务）+ 定时调度开关。
// v0.8.0 移植自 workbuddy2api-panel 的面板，适配 9router 的 UI 组件与 /api 路由。
import { useState, useEffect, useCallback } from "react";
import { Badge, Button, Card, Modal } from "@/shared/components";

const ACTIONS = [
  { id: "checkin", label: "立即签到", desc: "含连登兑换 + 抽奖闭环" },
  { id: "activity", label: "活跃上报", desc: "点亮连登 / 解锁领养" },
  { id: "travel", label: "猫猫旅行", desc: "派出 / 领奖 / 领养" },
  { id: "keepalive", label: "Token 保活", desc: "刷新 access token" },
  { id: "complete-all", label: "一键完成任务", desc: "全部账号 17 项成长任务" },
];

export default function CodeBuddyRewardsClient() {
  const [summary, setSummary] = useState({ accounts: [] });
  const [scheduler, setScheduler] = useState({ status: "stopped" });
  const [busy, setBusy] = useState("");
  const [logLines, setLogLines] = useState([]);
  const [tasks, setTasks] = useState(null);
  const [tasksFor, setTasksFor] = useState("");
  // v0.8.2：本机凭证扫描（只读探测 + 二次确认导入）
  const [scanOpen, setScanOpen] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);

  const pushLog = (msg) =>
    setLogLines((prev) => [`${new Date().toLocaleTimeString()} ${msg}`, ...prev].slice(0, 200));

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/codebuddy/rewards");
      const data = await res.json();
      setSummary(data);
      setScheduler(data.scheduler || { status: "stopped" });
    } catch (err) {
      pushLog(`加载失败: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/codebuddy/rewards");
        const data = await res.json();
        if (!alive) return;
        setSummary(data);
        setScheduler(data.scheduler || { status: "stopped" });
      } catch (err) {
        if (alive) pushLog(`加载失败: ${err.message}`);
      }
    })();
    return () => { alive = false; };
  }, []);

  const runAction = async (action, extra = {}) => {
    setBusy(action);
    pushLog(`执行 ${action} …`);
    try {
      const res = await fetch("/api/codebuddy/rewards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      pushLog(`${action} 完成: ${JSON.stringify(data).slice(0, 300)}`);
      await refresh();
    } catch (err) {
      pushLog(`${action} 失败: ${err.message}`);
    } finally {
      setBusy("");
    }
  };

  const loadTasks = async (connectionId) => {
    setTasksFor(connectionId);
    setTasks(null);
    try {
      const res = await fetch(`/api/codebuddy/rewards/tasks?connectionId=${encodeURIComponent(connectionId)}`);
      const data = await res.json();
      setTasks(data);
    } catch (err) {
      pushLog(`任务加载失败: ${err.message}`);
    }
  };

  // v0.8.2：只读扫描本机已登录凭证（不返回令牌）
  const openScan = async () => {
    setScanOpen(true);
    setScanLoading(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/codebuddy/credentials/scan");
      setScanResult(await res.json());
    } catch (err) {
      setScanResult({ items: [], error: err.message });
    } finally {
      setScanLoading(false);
    }
  };

  // v0.8.2：确认后把凭证写入账号池
  const importCredential = async (body) => {
    setBusy("import");
    try {
      const res = await fetch("/api/codebuddy/credentials/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) pushLog(`导入失败: ${data.error}`);
      (data.imported || []).forEach((i) => pushLog(`已导入 ${i.provider} / ${i.nickname}`));
      (data.errors || []).forEach((e) => pushLog(`导入告警: ${e}`));
      setScanOpen(false);
      await refresh();
    } catch (err) {
      pushLog(`导入失败: ${err.message}`);
    } finally {
      setBusy("");
    }
  };

  const toggleScheduler = () =>
    runAction(scheduler.status === "running" ? "scheduler-stop" : "scheduler-start");

  const accounts = summary.accounts || [];

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold">CodeBuddy 激励中心</h1>
            <p className="text-sm opacity-70 mt-1">
              签到 / 活跃 / 猫猫旅行 / Token 保活 / 成长任务一键完成（移植自 workbuddy2api-panel）
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm">
              定时调度：<b>{scheduler.status === "running" ? "运行中" : "已停止"}</b>
            </span>
            <Button variant={scheduler.status === "running" ? "secondary" : "primary"} onClick={toggleScheduler} disabled={!!busy}>
              {scheduler.status === "running" ? "停止调度" : "启动调度"}
            </Button>
            <Button variant="secondary" onClick={refresh} disabled={!!busy}>刷新</Button>
            <Button variant="secondary" onClick={openScan} disabled={!!busy}>扫描本机凭证</Button>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-3">批量操作</h2>
        <div className="flex flex-wrap gap-3">
          {ACTIONS.map((a) => (
            <Button key={a.id} onClick={() => runAction(a.id)} disabled={!!busy} title={a.desc}>
              {busy === a.id ? "执行中…" : a.label}
            </Button>
          ))}
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-3">账号（{accounts.length}）</h2>
        {accounts.length === 0 ? (
          <p className="text-sm opacity-70">未找到活跃的 CodeBuddy 连接（codebuddy-cn / codebuddy-intl）。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left opacity-70">
                  <th className="py-2 pr-4">账号</th>
                  <th className="py-2 pr-4">UID</th>
                  <th className="py-2 pr-4">区域</th>
                  <th className="py-2 pr-4">任务</th>
                  <th className="py-2 pr-4">可领</th>
                  <th className="py-2 pr-4">操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-t border-white/10">
                    <td className="py-2 pr-4">{a.nickname || a.id?.slice(0, 8) || "-"}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{a.uid || "-"}</td>
                    <td className="py-2 pr-4">{a.realm || "-"}</td>
                    <td className="py-2 pr-4">{a.error ? <span className="text-red-400">{a.error}</span> : (a.tasks ?? "-")}</td>
                    <td className="py-2 pr-4">{a.claimable ?? "-"}</td>
                    <td className="py-2 pr-4">
                      <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => loadTasks(a.id)} disabled={!!busy}>任务</Button>
                        <Button onClick={() => runAction("complete-tasks", { connectionId: a.id })} disabled={!!busy}>一键完成</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {tasksFor && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">任务列表 · {tasksFor.slice(0, 8)}</h2>
            <Button variant="secondary" onClick={() => { setTasks(null); setTasksFor(""); }}>关闭</Button>
          </div>
          {!tasks ? (
            <p className="text-sm opacity-70">加载中…</p>
          ) : tasks.error ? (
            <p className="text-sm text-red-400">{tasks.error}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-70">
                    <th className="py-2 pr-4">task_code</th>
                    <th className="py-2 pr-4">标题</th>
                    <th className="py-2 pr-4">进度</th>
                    <th className="py-2 pr-4">奖励</th>
                    <th className="py-2 pr-4">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {(tasks.tasks || []).map((t) => (
                    <tr key={t.taskCode} className="border-t border-white/10">
                      <td className="py-2 pr-4 font-mono text-xs">{t.taskCode}</td>
                      <td className="py-2 pr-4">{t.title || t.taskDesc || "-"}</td>
                      <td className="py-2 pr-4">{t.current}/{t.target}</td>
                      <td className="py-2 pr-4">{t.credit ? `+${t.credit}c` : ""}{t.energy ? ` +${t.energy}e` : ""}</td>
                      <td className="py-2 pr-4">
                        {t.claimed ? "已领取" : t.claimable ? "可领取" : (tasks.autoCodes || []).includes(t.taskCode) ? "可自动化" : "手动"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">运行日志</h2>
          <Button variant="secondary" onClick={() => setLogLines([])}>清空</Button>
        </div>
        <div className="font-mono text-xs space-y-1 max-h-72 overflow-y-auto">
          {logLines.length === 0 ? <p className="opacity-60">暂无日志</p> : logLines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </Card>

      {/* v0.8.2：本机凭证扫描结果（不显示任何令牌，导入需二次确认） */}
      <Modal isOpen={scanOpen} onClose={() => setScanOpen(false)} title="扫描本机已登录凭证">
        <div className="space-y-3">
          <p className="text-sm opacity-70">
            只读探测本机 WorkBuddy / CodeBuddy 客户端已登录的凭证（<b>不显示任何令牌</b>）。
            导入会把凭证写入账号池，请在确认账号与区域后手动点击「导入」。
          </p>
          {scanLoading ? (
            <p className="text-sm opacity-70">扫描中…</p>
          ) : scanResult?.error ? (
            <p className="text-sm text-red-400">! {scanResult.error}</p>
          ) : (scanResult?.items || []).length === 0 ? (
            <p className="text-sm opacity-70">未发现本机凭证（未登录或未安装对应客户端）。</p>
          ) : (
            <div className="divide-y divide-white/10">
              {scanResult.items.map((it) => (
                <div key={it.path} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={it.realm === "cn" ? "warning" : "info"}>{it.realmName}</Badge>
                      {it.valid ? <Badge variant="success">可导入</Badge> : <Badge variant="default">不可用</Badge>}
                    </div>
                    <p className="mt-1 text-xs opacity-70 truncate">
                      {it.nickname || it.uid || it.file}
                      {it.uin ? ` · uin ${it.uin}` : ""}
                      {it.expiresIn ? ` · 剩余 ${it.expiresIn}` : ""}
                    </p>
                    {it.error && <p className="mt-1 text-xs text-red-400">{it.error}</p>}
                  </div>
                  <Button
                    variant={it.valid ? "primary" : "secondary"}
                    disabled={!it.valid || busy === "import"}
                    onClick={() => importCredential({ path: it.path })}
                  >
                    导入
                  </Button>
                </div>
              ))}
            </div>
          )}
          {scanResult && (
            <p className="text-xs opacity-70">
              平台 {scanResult.platform} · 客户端 {scanResult.clientInstalled ? "已安装" : "未安装"}
            </p>
          )}
          {(scanResult?.items || []).some((i) => i.valid) && (
            <Button
              variant="secondary"
              disabled={busy === "import"}
              onClick={() => importCredential({ all: true })}
            >
              导入全部可用凭证
            </Button>
          )}
        </div>
      </Modal>
    </div>
  );
}