// ZCode-register 产物（成功.txt）的解析与凭证解密 —— 纯逻辑，仅依赖 node:crypto。
//
// ZCode 客户端把 credentials.json 的值以 "enc:v1:" 前缀做静态加密，方案直接来自
// 官方 app.asar 内的实现（credentialCipher）：
//   - 算法：AES-256-GCM，key = sha256(secret)，IV 12B，AuthTag 16B
//   - 密文形如 enc:v1:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>
//   - secret：环境变量 ZCODE_CREDENTIAL_SECRET，否则回退
//     `zcode-credential-fallback:<platform>:<homedir>:<username>`（即机器绑定）
//
// 成功.txt 每行格式（ZCode-register 输出）：
//   邮箱----密码----credentials.json 内容----config.json 内容
//
// 纯函数便于单测：加解密、解析、字段提取都不碰文件系统与网络。
// [ZCode-register 导入 v0.8.3]

import crypto from "node:crypto";
import os from "node:os";

const ENC_PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SECRET_ENV = "ZCODE_CREDENTIAL_SECRET";

/** 默认 secret：环境变量优先，否则机器绑定的回退串（与官方实现一致）。 */
export function defaultCredentialSecret(env = process.env, host = {}) {
  const explicit = env?.[SECRET_ENV];
  if (explicit) return explicit;
  const platform = host.platform || process.platform;
  const homedir = host.homedir || os.homedir();
  let username = host.username;
  if (username === undefined) {
    try {
      username = os.userInfo().username;
    } catch {
      username = "unknown";
    }
  }
  return `zcode-credential-fallback:${platform}:${homedir}:${username}`;
}

/** key = sha256(secret)。 */
export function deriveCredentialKey(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

/** 解一个 "enc:v1:" 值；非该前缀原样返回（兼容明文形态）。 */
export function decryptZcodeValue(value, key) {
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("ZCode 密文格式非法");
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64url"));
  if (iv.length !== IV_LENGTH) throw new Error("ZCode 密文 IV 长度非法");
  if (tag.length !== TAG_LENGTH) throw new Error("ZCode 密文 AuthTag 长度非法");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

/** 解密 credentials.json 的浅层键值（值可能是 enc:v1 密文）。 */
export function decryptCredentialRecord(credentials, env = process.env) {
  const key = deriveCredentialKey(defaultCredentialSecret(env));
  const out = {};
  for (const [k, v] of Object.entries(credentials || {})) {
    try {
      out[k] = decryptZcodeValue(v, key);
    } catch {
      out[k] = ""; // 单值解密失败不影响其它字段；缺失字段会在提取阶段报错
    }
  }
  return out;
}

/**
 * 解析 成功.txt 文本。
 * @returns {Array<{email,password,credentials,config,error}>}
 */
export function parseRegisterSuccessText(text) {
  const items = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i1 = line.indexOf("----");
    const i2 = i1 >= 0 ? line.indexOf("----", i1 + 4) : -1;
    const i3 = i2 >= 0 ? line.indexOf("----", i2 + 4) : -1;
    if (i1 < 0 || i2 < 0 || i3 < 0) {
      items.push({ email: "", password: "", credentials: null, config: null, error: "行格式不符（需 4 段以 ---- 分隔）" });
      continue;
    }
    const email = line.slice(0, i1).trim();
    const password = line.slice(i1 + 4, i2).trim();
    const credsRaw = line.slice(i2 + 4, i3).trim();
    const configRaw = line.slice(i3 + 4).trim();
    let credentials = null;
    let config = null;
    let error = "";
    try {
      credentials = JSON.parse(credsRaw);
    } catch (err) {
      error = `credentials.json 解析失败: ${err?.message || err}`;
    }
    try {
      config = JSON.parse(configRaw);
    } catch {
      config = null; // config 非导入必需
    }
    items.push({ email, password, credentials, config, error });
  }
  return items;
}

const PLAN_KEY_RE = /^account-provider:coding-plan:.*:api-key$/;

/**
 * 从（已加密的）credentials.json 中提取可供 9router 使用的账号字段。
 * @returns {{planKey,jwt,email,name,userId,provider,realm}}
 */
export function extractZcodeAccount(credentials, env = process.env) {
  const rec = decryptCredentialRecord(credentials, env);
  const planKeys = Object.keys(rec).filter((k) => PLAN_KEY_RE.test(k));
  // 个人套餐优先，其次团队套餐，最后任意一个
  const picked =
    planKeys.find((k) => k.includes("individual")) ||
    planKeys.find((k) => k.includes("team")) ||
    planKeys[0];
  const planKey = picked ? String(rec[picked] || "").trim() : "";
  const jwt = String(rec["zcodejwttoken"] || "").trim();

  let info = {};
  try {
    info = JSON.parse(rec["oauth:zai:user_info"] || "{}");
  } catch {
    info = {};
  }
  // 官方在缺失用户名时写入字符串 "None"，视为空
  const rawName = info?.name ?? info?.nickname;
  const name = rawName && rawName !== "None" ? String(rawName) : "";
  const activeProvider = String(rec["oauth:active_provider"] || "zai").trim();
  const provider = activeProvider === "bigmodel" ? "glm-cn" : "glm";

  return {
    planKey,
    jwt,
    email: String(info?.email || "").trim(),
    name,
    userId: String(info?.user_id || "").trim(),
    provider,
    realm: provider === "glm-cn" ? "cn" : "intl",
  };
}