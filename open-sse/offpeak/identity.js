// Minimal ZCode identity headers for the off-peak (async) upstream — ported
// from zcode-api src/proxy/identity.ts (buildIdentityHeaders, the
// context-shaped builder used by the async bridge).
//
// 9router has no desktop appVersion/deviceMid, so these are env-overridable with
// sensible defaults; the header ORDER mirrors the official builder.
import os from "node:os";
import { basename } from "node:path";

const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

function printable(raw) {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function osCategory(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

function clientLanguage() {
  const override = printable(process.env.ZCODE_IDENTITY_CLIENT_LANGUAGE);
  if (override) return override;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}

function clientTimezone() {
  const override = printable(process.env.ZCODE_IDENTITY_CLIENT_TIMEZONE);
  if (override) return override;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the identity values from env with runtime fallbacks. */
export function resolveZcodeIdentity() {
  const appVersion = printable(process.env.ZCODE_APP_VERSION) || "3.14.3";
  const platform = printable(process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform);
  const arch = printable(process.env.ZCODE_IDENTITY_ARCH ?? os.arch());
  const release = printable(process.env.ZCODE_IDENTITY_RELEASE ?? os.release());
  const releaseChannel =
    printable(process.env.ZCODE_IDENTITY_RELEASE_CHANNEL) ||
    (process.env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production");
  return {
    appVersion,
    platform,
    arch,
    release,
    releaseChannel,
    language: clientLanguage(),
    timezone: clientTimezone(),
    deviceMid: printable(process.env.ZCODE_IDENTITY_DEVICE_MID),
    refererOrigin: printable(process.env.ZCODE_IDENTITY_REFERER) || "https://zcode.z.ai",
    sourceTitle: printable(process.env.ZCODE_IDENTITY_SOURCE_TITLE) || "ZCode",
  };
}

/**
 * Context-shaped identity headers (bundle TV / buildZCodeSourceHeadersFromContext).
 * @returns {Record<string,string>}
 */
export function buildZcodeIdentityHeaders() {
  const v = resolveZcodeIdentity();
  return {
    "User-Agent": `ZCode/${v.appVersion}`,
    "HTTP-Referer": v.refererOrigin,
    "X-Title": `Z Code@${v.sourceTitle}`,
    ...(v.appVersion ? { "X-ZCode-App-Version": v.appVersion } : {}),
    ...(v.platform && v.arch ? { "X-Platform": `${v.platform}-${v.arch}` } : {}),
    ...(v.releaseChannel ? { "X-Release-Channel": v.releaseChannel } : {}),
    "X-Client-Language": v.language ?? "unknown",
    "X-Client-Timezone": v.timezone ?? "unknown",
    ...(v.platform ? { "X-Os-Category": osCategory(v.platform) } : {}),
    ...(v.release ? { "X-Os-Version": v.release } : {}),
    ...(v.deviceMid ? { "X-Device-Mid": v.deviceMid } : {}),
  };
}

/** Environment-info values for prompt assembly (kept for parity / future use). */
export function resolveEnvPromptInfo() {
  const platform = printable(process.env.ZCODE_IDENTITY_PLATFORM ?? process.platform) || "unknown";
  const release = printable(process.env.ZCODE_IDENTITY_RELEASE ?? os.release()) || "";
  const arch = printable(process.env.ZCODE_IDENTITY_ARCH ?? os.arch()) || "";
  const shellRaw = process.env.SHELL ?? process.env.ComSpec ?? process.env.COMSPEC ?? "";
  return {
    cwd: process.env.ZCODE_IDENTITY_ENV_CWD?.trim() || process.cwd(),
    platform,
    shell: shellRaw ? basename(shellRaw) : "unknown",
    osVersion: [platform, release, arch].filter((p) => p.length > 0).join(" "),
  };
}