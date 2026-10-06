import crypto from "crypto";
import { GLM_OAUTH_CONFIG } from "../constants/oauth.js";

// Zai / Bigmodel GLM Coding OAuth — CLI polling flow (mirrors the official
// ZCode CLI, apps/zcode-cli packages/adapters/src/auth/cli-oauth.ts +
// coding-plan-api-key.ts). No PKCE and no local callback server:
//
//   1) POST {cliInitUrl}   Authorization: Bearer <pollToken>  {"provider":"<providerId>"}
//        → { code: 0, data: { authorize_url, flow_id, poll_interval_sec, expires_at } }
//   2) Browser opens authorize_url; user signs in with the Z.ai / Bigmodel account
//   3) GET {cliPollUrl}/<flow_id>   Authorization: Bearer <pollToken>
//        → { data: { status: "pending" } } until
//          { data: { status: "ready", token, user, <providerId>: { access_token, refresh_token? } } }
//   4) resolveCodingPlanApiKey() derives the long-lived coding-plan API key
//      (Z.ai and Bigmodel derivation differ — see below)
//
// The coding-plan API key is the long-lived model credential; neither OAuth
// provider has a refresh_token grant, so expiry means re-login (same as the
// official CLI). zcode JWT + business token ride along in providerSpecificData
// for quota/usage and debugging.
//
// v0.7.0 新增 bigmodel 变体：同一个 CLI 轮询协议，但 providerId="bigmodel"，
// 凭证推导走 bigmodel.cn（不经 z/login 换票、密钥后缀非强制）。
// 见 createGlmProvider / resolveCodingPlanApiKey。
const glm = createGlmProvider(GLM_OAUTH_CONFIG);

/**
 * Build a GLM-family OAuth provider handler for a given registry config.
 * Exported so `glm-cn.js` (Bigmodel) can reuse the identical poll protocol.
 * @param {object} config - registry `oauth` block (PROVIDER_OAUTH[<id>])
 */
export function createGlmProvider(config) {
  return {
    config,
    flowType: "device_code",
    requestDeviceCode: async (cfg) => {
      const pollToken = crypto.randomBytes(32).toString("hex");
      const response = await fetch(cfg.cliInitUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pollToken}`,
        },
        body: JSON.stringify({ provider: cfg.providerId || "zai" }),
      });
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ZCode OAuth init failed: ${error}`);
      }
      const payload = await response.json();
      if (!isSuccessCode(payload.code) || !payload.data) {
        throw new Error(payload.msg || "ZCode OAuth init returned no data");
      }
      const data = payload.data;
      if (!data.flow_id || !data.authorize_url) {
        throw new Error("ZCode OAuth init response missing flow_id/authorize_url");
      }
      return {
        device_code: data.flow_id,
        verification_uri: data.authorize_url,
        // expires_at is upstream-absolute; surface a relative deadline for the UI
        expires_in: relativeSeconds(data.expires_at) ?? 300,
        interval: data.poll_interval_sec || 3,
        _zcodePollToken: pollToken,
      };
    },
    pollToken: async (cfg, deviceCode, _codeVerifier, extraData) => {
      const pollToken = extraData?._zcodePollToken;
      if (!pollToken) {
        return {
          ok: true,
          data: {
            error: "access_denied",
            error_description: "Missing ZCode poll token — restart the login flow",
          },
        };
      }

      const response = await fetch(`${cfg.cliPollUrl}/${encodeURIComponent(deviceCode)}`, {
        headers: { Authorization: `Bearer ${pollToken}` },
      });
      if (!response.ok) {
        return {
          ok: true,
          data: {
            error: "access_denied",
            error_description: `ZCode poll failed (HTTP ${response.status})`,
          },
        };
      }

      const payload = await response.json();
      if (!isSuccessCode(payload.code)) {
        return {
          ok: true,
          data: { error: "access_denied", error_description: payload.msg || "ZCode poll failed" },
        };
      }

      const data = payload.data || {};
      if (data.status === "pending") {
        return { ok: true, data: { error: "authorization_pending" } };
      }
      if (data.status === "failed") {
        return {
          ok: true,
          data: {
            error: "access_denied",
            error_description: "ZCode authorization failed or was cancelled",
          },
        };
      }
      if (data.status !== "ready") {
        return {
          ok: true,
          data: { error: "authorization_pending", error_description: `Unknown status: ${data.status}` },
        };
      }

      // ready payload nests the provider OAuth tokens under data[providerId] (see
      // apps/zcode-cli cli-oauth.ts parseReadyData): { status:"ready", token,
      // user, zai|bigmodel: { access_token, refresh_token? } }. Fall back to
      // top-level fields for resilience against payload drift.
      const providerKey = cfg.providerId || "zai";
      const providerData = data[providerKey] || data[data.providerId] || {};
      const providerAccessToken =
        providerData.access_token ||
        providerData.accessToken ||
        data.accessToken ||
        data.access_token;
      if (!providerAccessToken) {
        return {
          ok: true,
          data: {
            error: "access_denied",
            error_description: "ZCode poll response missing access token",
          },
        };
      }

      // providerAccessToken is the Z.AI / Bigmodel OAuth token → derive plan key
      const { planApiKey, businessToken } = await resolveCodingPlanApiKey(cfg, providerAccessToken);

      return {
        ok: true,
        data: {
          access_token: planApiKey,
          _zcodeJwtToken: data.token || "",
          _zaiBusinessToken: businessToken,
          _zaiRefreshToken:
            providerData.refresh_token || providerData.refreshToken || data.refresh_token || data.refreshToken || "",
          _zcodeUser: data.user || {},
        },
      };
    },
    mapTokens: (tokens) => {
      const user = tokens._zcodeUser || {};
      const displayName = user.name || user.email || null;
      return {
        accessToken: tokens.access_token,
        refreshToken: null,
        email: user.email || null,
        ...(displayName ? { displayName } : {}),
        providerSpecificData: {
          authMethod: "cli_poll",
          username: user.name || undefined,
          userId: user.user_id || undefined,
          zcodeJwtToken: tokens._zcodeJwtToken || undefined,
          zaiBusinessToken: tokens._zaiBusinessToken || undefined,
          ...(tokens._zaiRefreshToken ? { zaiRefreshToken: tokens._zaiRefreshToken } : {}),
        },
      };
    },
  };
}

// OAuth provider token → coding-plan API key ("apiKey.secretKey"). Mirrors
// ZCode CLI coding-plan-api-key.ts: getCustomerInfo → default org/project →
// api_keys list/create(<planApiKeyName>) → copy → secretKey.
//
// v0.7.0 bigmodel 差异:
//   - apiBaseUrl 为 https://bigmodel.cn；Z.ai 为 https://api.z.ai
//   - Z.ai 先用 z/login 把 OAuth token 换成 business JWT（businessLoginUrl），
//     请求头带 "Bearer "；bigmodel 直接用 OAuth token 作业务凭证（原样放入
//     Authorization，不加 Bearer）
//   - Z.ai 必须取到 secretKey 后缀；bigmodel 取不到时退化为纯 apiKey
//     （requireSecretKey:false）
async function resolveCodingPlanApiKey(config, providerAccessToken) {
  const useBusinessLogin = Boolean(config.businessLoginUrl);
  const businessToken = useBusinessLogin
    ? await exchangeBusinessToken(config, providerAccessToken)
    : providerAccessToken;
  const authHeaders = {
    Authorization: useBusinessLogin ? `Bearer ${businessToken}` : businessToken,
    "Content-Type": "application/json",
  };

  const customerInfo = await fetchBusinessJson(
    `${config.apiBaseUrl}/api/biz/customer/getCustomerInfo`,
    { headers: authHeaders },
    "customer info"
  );
  const location = pickOrgAndProject(customerInfo);
  if (!location) {
    throw new Error("Unable to resolve Z.ai organization and project for the coding plan");
  }

  const listUrl =
    `${config.apiBaseUrl}/api/biz/v1/organization/${location.organizationId}` +
    `/projects/${location.projectId}/api_keys`;
  const keys = (await fetchBusinessJson(listUrl, { headers: authHeaders }, "api keys")) || [];
  let keyEntry = Array.isArray(keys)
    ? keys.find((item) => item?.name === config.planApiKeyName)
    : null;
  if (!keyEntry) {
    keyEntry = await fetchBusinessJson(
      listUrl,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: config.planApiKeyName }),
      },
      "api key create"
    );
  }

  const apiKey = keyEntry?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Z.ai api_keys response is missing apiKey");
  }

  // copy → secretKey；bigmodel 视为尽力而为（纯 apiKey 也能用）
  let secret;
  try {
    secret = await fetchBusinessJson(
      `${listUrl}/copy/${encodeURIComponent(apiKey)}`,
      { headers: authHeaders },
      "api key copy"
    );
  } catch (error) {
    if (config.requireSecretKey === false) return { planApiKey: apiKey, businessToken };
    throw error;
  }
  const secretKey = secret?.secretKey?.trim();
  if (!secretKey) {
    if (config.requireSecretKey === false) return { planApiKey: apiKey, businessToken };
    throw new Error("Z.ai api key copy response is missing secretKey");
  }

  return { planApiKey: `${apiKey}.${secretKey}`, businessToken };
}

// POST {businessLoginUrl} {"token": <provider oauth token>} → { data: { access_token } }
async function exchangeBusinessToken(config, providerAccessToken) {
  const payload = await fetchBusinessJson(
    config.businessLoginUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: providerAccessToken }),
    },
    "Z.ai business login"
  );
  const token = payload?.access_token?.trim() || payload?.accessToken?.trim();
  if (!token) {
    throw new Error("Z.ai business login response is missing access_token");
  }
  return token;
}

// Business endpoints answer {code, msg, data}; code 0/200 (or absent) = success.
// data is returned directly (null when missing).
async function fetchBusinessJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Z.ai ${label} request failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Z.ai ${label} response is not valid JSON`);
  }
  if (!isSuccessCode(payload?.code) || payload?.success === false) {
    throw new Error(payload?.msg || `Z.ai ${label} returned business error ${payload?.code}`);
  }
  return payload?.data ?? payload ?? null;
}

// Prefer the org named "默认机构"/"default" and the non-team project named
// "默认项目"/"default" (projectType "2" = team), falling back to the first entries.
function pickOrgAndProject(customerInfo) {
  const organizations = Array.isArray(customerInfo?.organizations)
    ? customerInfo.organizations
    : [];
  const personalOrgs = organizations
    .map((organization) => ({
      organization,
      projects: (organization?.projects || []).filter(
        (project) => String(project?.projectType ?? "").trim() !== "2"
      ),
    }))
    .filter(({ organization, projects }) =>
      Boolean(organization?.organizationId && projects.length)
    );
  if (!personalOrgs.length) return null;

  const org =
    personalOrgs.find(({ organization }) => isDefaultName(organization.organizationName)) ||
    personalOrgs[0];
  const project =
    org.projects.find((item) => isDefaultName(item?.projectName)) || org.projects[0];
  if (!org.organization?.organizationId || !project?.projectId) return null;
  return { organizationId: org.organization.organizationId, projectId: project.projectId };
}

function isDefaultName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return normalized.includes("默认机构") || normalized.includes("默认项目") || normalized === "default";
}

function isSuccessCode(code) {
  return code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
}

// Absolute epoch (s or ms) → seconds from now; null when absent/invalid.
function relativeSeconds(expiresAt) {
  const raw = Number(expiresAt);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const seconds = Math.floor((ms - Date.now()) / 1000);
  return seconds > 0 ? seconds : null;
}

export default glm;