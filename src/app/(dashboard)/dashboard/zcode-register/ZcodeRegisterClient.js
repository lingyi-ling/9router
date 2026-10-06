"use client";

// ZCode-register 产物导入：把 成功.txt 里注册好的 Z.ai 账号写入 glm / glm-cn 账号池。
// 只做触发与展示；解密与建连全部在服务端（/api/zcode/credentials/import-register）。
// [ZCode-register 导入 v0.8.3]
import { useState } from "react";
import { Badge, Button, Card } from "@/shared/components";

const SAMPLE_HINT = "每行：邮箱----密码----credentials.json 内容----config.json 内容";

export default function ZcodeRegisterClient() {
  const [text, setText] = useState("");
  const [filePath, setFilePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const body = filePath.trim() ? { path: filePath.trim() } : { text };
      const res = await fetch("/api/zcode/credentials/import-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && (text.trim().length > 0 || filePath.trim().length > 0);

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-semibold">ZCode 账号导入</h1>
            <p className="text-sm opacity-70 mt-1">
              导入 ZCode-register 的 <b>成功.txt</b>，自动解密凭证并写入 glm / glm-cn 账号池
            </p>
          </div>
          <Badge variant="info">仅本机可访问</Badge>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-3">导入来源</h2>
        <label className="text-sm opacity-70">本机 成功.txt 路径（优先）</label>
        <input
          className="mt-1 mb-4 w-full rounded-[10px] border border-border-subtle bg-bg px-3 py-2 text-sm"
          placeholder="C:\\dist\\成功.txt"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
        />
        <label className="text-sm opacity-70">或直接粘贴内容</label>
        <textarea
          className="mt-1 w-full rounded-[10px] border border-border-subtle bg-bg px-3 py-2 font-mono text-xs"
          rows={8}
          placeholder={SAMPLE_HINT}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={submit} disabled={!canSubmit}>{busy ? "导入中…" : "开始导入"}</Button>
          <span className="text-xs opacity-60">{SAMPLE_HINT}</span>
        </div>
      </Card>

      {error && (
        <Card>
          <p className="text-sm text-red-400">! {error}</p>
        </Card>
      )}

      {result && (
        <Card>
          <h2 className="font-semibold mb-3">
            导入结果：成功 {result.imported?.length || 0} / 共 {result.total || 0}
          </h2>
          {(result.imported || []).length > 0 && (
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left opacity-70">
                    <th className="py-2 pr-4">账号</th>
                    <th className="py-2 pr-4">Provider</th>
                    <th className="py-2 pr-4">区域</th>
                    <th className="py-2 pr-4">User ID</th>
                  </tr>
                </thead>
                <tbody>
                  {(result.imported || []).map((it) => (
                    <tr key={it.id} className="border-t border-white/10">
                      <td className="py-2 pr-4">{it.nickname || "-"}</td>
                      <td className="py-2 pr-4">{it.provider}</td>
                      <td className="py-2 pr-4">{it.realm}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{it.userId || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(result.errors || []).length > 0 && (
            <div className="font-mono text-xs space-y-1">
              {(result.errors || []).map((e, i) => (
                <div key={i} className="text-yellow-500">! {e}</div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}