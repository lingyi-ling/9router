import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "glm-cn",
  priority: 130,
  alias: "glm-cn",
  display: {
    name: "GLM (China)",
    icon: "code",
    color: "#DC2626",
    textIcon: "GC",
    website: "https://open.bigmodel.cn",
    notice: {
      apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    },
  },
  // v0.7.0 双鉴权：可粘贴 API Key，也可用 Bigmodel 账号 OAuth 登录自动换取
  // coding-plan key（与 glm/Z.ai 同一套 ZCode CLI 轮询协议）。
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  // Bigmodel 走与 glm 相同的 zcode.z.ai CLI 轮询端点，仅 providerId 不同；
  // 凭证推导用 bigmodel.cn 业务接口（不走 z/login，secretKey 非强制）。
  oauth: {
    providerId: "bigmodel",
    cliInitUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
    cliPollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll",
    apiBaseUrl: "https://bigmodel.cn",
    planApiKeyName: "zcode-api-key",
    requireSecretKey: false,
  },
  transport: {
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    headers: {},
    usage: {
      url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (Vision)" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-5v-turbo", name: "GLM 5V Turbo (Vision)" },
    { id: "glm-4.7", name: "GLM-4.7" },
    { id: "glm-4.6v", name: "GLM 4.6V (Vision)" },
    { id: "glm-4.6", name: "GLM-4.6" },
    { id: "glm-4.5-air", name: "GLM-4.5-Air" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};