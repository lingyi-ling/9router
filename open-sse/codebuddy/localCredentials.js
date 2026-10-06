// CodeBuddy / WorkBuddy 本机已登录凭证的只读探测与导入。
//
// 与 qoder 扫描（open-sse/shared/qoder/localCredentials.js）的差异：
//   - 官方桌面端的凭证文件是 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info
//     （JSON），其中 accessToken / refreshToken / nickname 被 "$wbEncrypted" 信封加密
//     （AES-256-GCM，sym-v1）。
//   - 解密密钥不在任何文件里：build key 由官方补丁版 Electron 的原生绑定
//     electron_browser_workbuddy_storage.loggerGet() 提供，编译在 WorkBuddyAI.exe 内。
//     这里以 ELECTRON_RUN_AS_NODE 方式拉起官方 exe 执行极小的探针脚本取回该 key，
//     再用纯 Node crypto 还原信封（算法逐字对齐官方 codebuddy-headless.js 的
//     AtRestCrypto / buildAuthenticatedContextAad，已实测解密成功）。
//
// 扫描全程只读，且**不返回任何明文令牌**（只报可读性/有效性/uid/昵称/过期时间）；
// 导入必须由用户在看板二次确认后，才由 readCredentialForImport 取出令牌。
// [workbuddy 本机凭证 v0.8.2]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// ── 官方 at-rest 加密常量（对齐 codebuddy-headless.js 模块 78149） ──────────
const AAD_PREFIX = Buffer.from("WB-AAD\0", "ascii");
const SUITE_AES_256_GCM_V1 = 1;
const FRAME_NUM = { file: 1, field: 2, record: 3, stream: 4 };
const FRAME_MAGIC = { file: "WBEF1", field: "WBEV1", record: "WBER1", stream: "WBES1" };

const PROBE_FILE = "9router-workbuddy-key-probe.cjs";
const PROBE_SOURCE = [
  'const b = process._linkedBinding("electron_browser_workbuddy_storage");',
  "const raw = b.loggerGet();",
  'process.stdout.write(typeof raw === "string" ? raw : raw.toString("utf8"));',
].join("\n");

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n);
  return b;
}

function lenPrefixed(str) {
  const b = Buffer.from(str, "utf8");
  return Buffer.concat([u32(b.length), b]);
}

/** sym-v1 的认证附加数据：ASCII 前缀 + 版本 + framing 幻数 + scheme + suite + keyId + framing 序数。 */
function buildAuthenticatedContextAad(keyId, suite, framing) {
  return Buffer.concat([
    AAD_PREFIX,
    Buffer.from([1]),
    lenPrefixed(FRAME_MAGIC[framing]),
    lenPrefixed("sym-v1"),
    u32(suite),
    lenPrefixed(keyId),
    Buffer.from([FRAME_NUM[framing]]),
    Buffer.from([0]), // 可选的 sequence（whole-value 语境下缺省）
    Buffer.from([0]), // 可选的 final（缺省）
  ]);
}

/** 16 位小写 hex 的 keyId = sha256(key) 前 8 字节。 */
function deriveKeyId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** build key payload 的 atRestSecretKey（base64）→ 32 字节对称密钥：对 base64 字符串本身做 sha256。 */
function deriveKeyFromPayload(payload) {
  return crypto.createHash("sha256").update(payload.atRestSecretKey, "utf8").digest();
}

/** 打开一个 suite-1 sym-v1 信封（AES-256-GCM）。 */
function openEnvelope(envelope, key, framing) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"), {
    authTagLength: 16,
  });
  decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite, framing));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
}

/** 解开 "$wbEncrypted" 字段包装（{ $wbEncrypted:1, envelope:"<base64 json>" }）。 */
function openField(wrapper, key, keyId) {
  if (!wrapper || typeof wrapper !== "object" || !wrapper.envelope) {
    throw new Error("not an encrypted field wrapper");
  }
  const envelope = JSON.parse(Buffer.from(wrapper.envelope, "base64").toString("utf8"));
  if (envelope.keyId !== keyId) throw new Error(`key id mismatch (envelope=${envelope.keyId})`);
  return openEnvelope(envelope, key, "field");
}

// ── 本机路径发现 ───────────────────────────────────────────────────────────
function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

/** 官方桌面端安装目录下的 WorkBuddyAI 可执行文件候选。 */
function workbuddyExeCandidates() {
  const out = [];
  if (process.env.WORKBUDDY_EXE) out.push(process.env.WORKBUDDY_EXE);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || homePath("AppData", "Local");
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    out.push(
      path.join(local, "Programs", "WorkBuddyAI", "WorkBuddyAI.exe"),
      path.join(local, "Programs", "WorkBuddy AI", "WorkBuddyAI.exe"),
      path.join(pf, "WorkBuddyAI", "WorkBuddyAI.exe"),
      path.join(pf86, "WorkBuddyAI", "WorkBuddyAI.exe"),
    );
  } else if (process.platform === "darwin") {
    out.push(
      "/Applications/WorkBuddy AI.app/Contents/MacOS/WorkBuddy AI",
      "/Applications/WorkBuddyAI.app/Contents/MacOS/WorkBuddyAI",
      homePath("Applications", "WorkBuddy AI.app", "Contents", "MacOS", "WorkBuddy AI"),
    );
  }
  return out;
}

function findWorkbuddyExe() {
  for (const candidate of workbuddyExeCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return "";
}

/** 官方扩展 / 桌面端存放登录凭证的目录（与客户端沙箱策略列出的路径一致）。 */
function credentialAuthDirs() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || homePath("AppData", "Local");
    return [path.join(local, "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  if (process.platform === "darwin") {
    return [homePath("Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  return [homePath(".local", "share", "CodeBuddyExtension", "Data", "Public", "auth")];
}

// ── build key 获取（借官方原生绑定） ───────────────────────────────────────
function ensureProbeFile() {
  const file = path.join(os.tmpdir(), PROBE_FILE);
  try {
    if (fs.readFileSync(file, "utf8") === PROBE_SOURCE) return file;
  } catch { /* 不存在或不可读则重写 */ }
  fs.writeFileSync(file, PROBE_SOURCE, "utf8");
  return file;
}

/**
 * 取回官方 build key payload。仅在本机安装了 WorkBuddy 客户端时可用。
 * @returns {{version:number, atRestSecretKey:string}}
 */
export function readBuildKeyPayload() {
  const exe = findWorkbuddyExe();
  if (!exe) throw new Error("未找到 WorkBuddy 客户端（WorkBuddyAI.exe），无法解密本机凭证");
  const probe = ensureProbeFile();
  const raw = execFileSync(exe, [probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const text = raw.toString("utf8").trim();
  if (!text) throw new Error("WorkBuddy 原生绑定未返回 build key");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("build key payload 不是合法 JSON");
  }
  if (payload?.version !== 1 || typeof payload?.atRestSecretKey !== "string") {
    throw new Error("build key payload 结构不受支持");
  }
  return payload;
}

/** 时间戳归一：支持秒/毫秒/微秒/纳秒纪元；无法解析返回 0。 */
function normalizeEpoch(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1e16) return Math.floor(n / 1e9);
  if (n >= 1e13) return Math.floor(n / 1e6);
  if (n >= 1e11) return Math.floor(n / 1e3);
  return Math.floor(n);
}

function humanDelta(seconds) {
  if (seconds <= 0) return "已过期";
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)} 天`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${Math.round(seconds / 60)} 分钟`;
}

/** domain → 归一化区域：workbuddy.ai 家族 = global，否则 cn。 */
function realmOfDomain(domain) {
  const d = String(domain || "").toLowerCase().trim();
  return d === "workbuddy.ai" || d.endsWith(".workbuddy.ai") ? "global" : "cn";
}

const REALM_PROVIDER = { global: "codebuddy-intl", cn: "codebuddy-cn" };
const REALM_NAME = { global: "国际版", cn: "国内版" };

/** 读取单个凭证文件并解出明文（扫描阶段只用其非敏感字段）。 */
function readAuthFile(filePath, key, keyId) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const account = raw.account || {};
  const auth = raw.auth || {};
  const decrypt = (wrapper) => {
    if (wrapper == null) return "";
    if (typeof wrapper === "string") return wrapper; // 兼容未加密的旧形态
    return openField(wrapper, key, keyId).toString("utf8");
  };
  return {
    uid: String(account.uid || ""),
    uin: String(account.uin || ""),
    nickname: decrypt(account.nickname),
    accessToken: decrypt(auth.accessToken),
    refreshToken: decrypt(auth.refreshToken),
    domain: String(auth.domain || ""),
    expiresAt: normalizeEpoch(auth.expiresAt),
  };
}

/**
 * 只读探测本机已登录的 CodeBuddy / WorkBuddy 凭证。返回候选列表（**不含任何明文令牌**）。
 * @returns {Array<{kind,path,file,realm,realmName,provider,readable,valid,uid,nickname,uin,domain,expiresAt,expiresIn,error}>}
 */
export function scanLocalCredentials() {
  const found = [];
  let key = null;
  let keyId = "";
  let keyError = "";
  try {
    const payload = readBuildKeyPayload();
    key = deriveKeyFromPayload(payload);
    keyId = deriveKeyId(key);
  } catch (err) {
    keyError = err?.message || String(err);
  }

  for (const dir of credentialAuthDirs()) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".info"));
    } catch {
      continue; // 目录不存在 = 该客户端未登录/未安装
    }
    for (const name of names) {
      const filePath = path.join(dir, name);
      const item = {
        kind: "app",
        path: filePath,
        file: name,
        realm: "cn",
        realmName: REALM_NAME.cn,
        provider: REALM_PROVIDER.cn,
        readable: false,
        valid: false,
        uid: "",
        nickname: "",
        uin: "",
        domain: "",
        expiresAt: 0,
        expiresIn: null,
        error: "",
      };
      if (!key) {
        item.error = keyError || "无法获取 WorkBuddy build key";
        found.push(item);
        continue;
      }
      try {
        const cred = readAuthFile(filePath, key, keyId);
        item.realm = realmOfDomain(cred.domain);
        item.realmName = REALM_NAME[item.realm];
        item.provider = REALM_PROVIDER[item.realm];
        item.readable = true;
        item.valid = Boolean(cred.accessToken && cred.refreshToken);
        item.uid = cred.uid;
        item.nickname = cred.nickname;
        item.uin = cred.uin;
        item.domain = cred.domain;
        item.expiresAt = cred.expiresAt;
        item.expiresIn = cred.expiresAt ? humanDelta(cred.expiresAt - Date.now() / 1000) : null;
      } catch (err) {
        item.error = String(err?.message || err);
      }
      found.push(item);
    }
  }
  return found;
}

/**
 * 取出某个已扫描凭证的令牌（仅在看板二次确认后调用）。
 * @returns {{accessToken,refreshToken,uid,nickname,uin,domain,realm,expiresAt}}
 */
export function readCredentialForImport(filePath) {
  const payload = readBuildKeyPayload();
  const key = deriveKeyFromPayload(payload);
  const keyId = deriveKeyId(key);
  const cred = readAuthFile(filePath, key, keyId);
  return { ...cred, realm: realmOfDomain(cred.domain) };
}

/** 扫描能力自检（供路由返回给前端展示）。 */
export function localCredentialScanCapability() {
  const exe = findWorkbuddyExe();
  return {
    platform: process.platform,
    clientInstalled: Boolean(exe),
    clientPath: exe,
    authDirs: credentialAuthDirs(),
  };
}