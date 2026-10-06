import { NextResponse } from "next/server";

import { createProviderConnection } from "@/models";
import { readCredentialForImport, scanLocalCredentials } from "open-sse/codebuddy/localCredentials.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** realm → provider id 映射（与 open-sse/providers/registry 一致）。 */
const REALM_PROVIDER = { global: "codebuddy-intl", cn: "codebuddy-cn" };

function toIso(epochSeconds) {
  if (!epochSeconds) return undefined;
  return new Date(epochSeconds * 1000).toISOString();
}

async function importOne(filePath) {
  const cred = readCredentialForImport(filePath);
  if (!cred?.accessToken) throw new Error("未从该文件解出可用令牌");
  const provider = REALM_PROVIDER[cred.realm] || "codebuddy-cn";
  const psd = {
    uid: cred.uid || "",
    nickname: cred.nickname || "",
    uin: cred.uin || "",
    realm: cred.realm,
    domain: cred.domain || "",
    authMethod: "local-import",
    importedFrom: filePath,
  };
  const connection = await createProviderConnection({
    provider,
    authType: "oauth",
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken || undefined,
    expiresAt: toIso(cred.expiresAt),
    // 去重依赖稳定标识：无邮箱，用 uid 派生
    email: cred.uid ? `codebuddy-user-${cred.uid}` : undefined,
    displayName: cred.nickname || undefined,
    providerSpecificData: psd,
    allowOverwrite: true,
  });
  return {
    id: connection.id,
    provider,
    nickname: cred.nickname || cred.uid || connection.id.slice(0, 8),
    realm: cred.realm,
    file: filePath,
  };
}

/**
 * POST /api/codebuddy/credentials/import
 * body: { path: string }   导入单个
 *     | { all: true }      导入全部有效项
 *
 * 这是写入账号池的动作，必须由用户在扫描结果上二次确认后调用。
 * [workbuddy 本机凭证 v0.8.2]
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body.all) {
      const candidates = scanLocalCredentials().filter((i) => i.valid);
      const imported = [];
      const errors = [];
      for (const item of candidates) {
        try {
          imported.push(await importOne(item.path));
        } catch (err) {
          errors.push(`${item.file}: ${err?.message ?? err}`);
        }
      }
      return NextResponse.json({ ok: imported.length > 0, imported, errors });
    }

    if (!body.path || typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required (或传 all:true)" }, { status: 400 });
    }
    const result = await importOne(body.path);
    return NextResponse.json({ ok: true, imported: [result], errors: [] });
  } catch (error) {
    console.error("[API] CodeBuddy credential import failed:", error);
    return NextResponse.json({ error: String(error?.message || "Credential import failed") }, { status: 500 });
  }
}