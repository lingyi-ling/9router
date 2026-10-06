import { GLM_CN_OAUTH_CONFIG } from "../constants/oauth.js";
import { createGlmProvider } from "./glm.js";

// Bigmodel (智谱 / open.bigmodel.cn) GLM Coding OAuth — same ZCode CLI polling
// protocol as the `glm` (Z.ai) provider, but the login is Bigmodel-branded
// (`providerId:"bigmodel"`) and the coding-plan key is derived from the
// bigmodel.cn business API (no z/login exchange, secretKey suffix optional).
// See createGlmProvider in glm.js for the shared flow.
//
// v0.7.0 与 glm 共用轮询实现，仅配置不同（providerId / apiBaseUrl /
// requireSecretKey），避免重复维护两套协议。
const glmCn = createGlmProvider(GLM_CN_OAUTH_CONFIG);

export default glmCn;