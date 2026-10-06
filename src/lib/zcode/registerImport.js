// ZCode-register 产物导入 —— 9router 侧接线：把 成功.txt 里的账号写入 glm / glm-cn 账号池。
//
// 与 glm OAuth 流程（src/lib/oauth/providers/glm.js mapTokens）保持同一连接形态：
//   accessToken = coding-plan API key（apiKey.secretKey 全串），
//   providerSpecificData.zcodeJwtToken = ZCode JWT（官方网关功能与秒抢都要它）。
// 区别只在 authMethod 标记为 register_import，且没有 zaiBusinessToken（生产代码未读取）。
// [ZCode-register 导入 v0.8.3]

import fs from "node:fs";
import { createProviderConnection } from "@/models";
import { parseRegisterSuccessText, extractZcodeAccount } from "open-sse/zcode/registerArtifacts.js";

/**
 * 逐条导入，单条失败不影响其余。
 * @param {string} text - 成功.txt 文本
 * @param {object} [opts]
 * @param {object} [opts.env] - 解密环境（默认 process.env）
 * @returns {Promise<{total:number, imported:Array, errors:string[]}>}
 */
export async function importRegisterText(text, opts = {}) {
  const env = opts.env || process.env;
  const items = parseRegisterSuccessText(text);
  const imported = [];
  const errors = [];

  for (const item of items) {
    if (item.error) {
      errors.push(`${item.email || "(无邮箱)"}: ${item.error}`);
      continue;
    }
    try {
      const acct = extractZcodeAccount(item.credentials, env);
      if (!acct.planKey) throw new Error("未找到 coding-plan API key（账号可能未开通套餐）");
      if (!acct.jwt) throw new Error("未找到 zcode JWT");

      const connection = await createProviderConnection({
        provider: acct.provider,
        authType: "oauth",
        accessToken: acct.planKey,
        email: acct.email || (acct.userId ? `zcode-user-${acct.userId}` : undefined),
        displayName: acct.name || undefined,
        providerSpecificData: {
          authMethod: "register_import",
          username: acct.name || undefined,
          userId: acct.userId || undefined,
          zcodeJwtToken: acct.jwt,
        },
        allowOverwrite: true,
      });

      imported.push({
        id: connection.id,
        provider: acct.provider,
        realm: acct.realm,
        email: acct.email,
        userId: acct.userId,
        nickname: acct.name || acct.email || connection.id.slice(0, 8),
      });
    } catch (err) {
      errors.push(`${item.email || "(无邮箱)"}: ${err?.message || err}`);
    }
  }

  return { total: items.length, imported, errors };
}

/** 读取本地 成功.txt 并导入（仅本机路由调用）。 */
export async function importRegisterFile(filePath, opts = {}) {
  const text = fs.readFileSync(filePath, "utf8");
  return importRegisterText(text, opts);
}