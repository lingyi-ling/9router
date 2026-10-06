import { NextResponse } from "next/server";

import { importRegisterText, importRegisterFile } from "@/lib/zcode/registerImport.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/zcode/credentials/import-register
 * body: { text: string }  直接粘贴 成功.txt 内容
 *     | { path: string }  读取本机 成功.txt（仅本机可访问）
 *
 * 把 ZCode-register 注册好的账号写入 glm / glm-cn 账号池。
 * credentials.json 的 enc:v1 密文由服务端解密（机器绑定 secret，见
 * open-sse/zcode/registerArtifacts.js）。
 * [ZCode-register 导入 v0.8.3]
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text : "";
    const filePath = typeof body?.path === "string" ? body.path.trim() : "";

    if (!text && !filePath) {
      return NextResponse.json({ error: "需要 text（粘贴内容）或 path（本机文件路径）" }, { status: 400 });
    }

    const result = filePath ? await importRegisterFile(filePath) : await importRegisterText(text);
    return NextResponse.json({ ok: result.imported.length > 0, ...result });
  } catch (error) {
    console.error("[API] ZCode register import failed:", error);
    return NextResponse.json({ error: String(error?.message || "Register import failed") }, { status: 500 });
  }
}