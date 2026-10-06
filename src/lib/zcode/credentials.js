// Shared ZCode (glm / glm-cn) credential resolver for the official gateway
// features (plugin-MCP relay + off-peak async channel).
//
// Both planes need the OAuth-minted coding-plan key PLUS the ZCode JWT captured
// at login time; a pasted API-key connection has no JWT and cannot use either.
// Reads active connections read-only (no rotation bookkeeping side effects).
import { getProviderConnections } from "@/lib/localDb";

const ZCODE_PROVIDERS = ["glm", "glm-cn"];

/** Coding-plan API key for a connection: OAuth stores it on accessToken. */
export function zcodePlanKey(conn) {
  return (conn?.accessToken || conn?.apiKey || "").trim();
}

/**
 * @returns {{jwt:string, planKey:string, provider:string} | null}
 */
export async function resolveZcodeCredential() {
  for (const provider of ZCODE_PROVIDERS) {
    let connections = [];
    try {
      connections = await getProviderConnections({ provider, isActive: true });
    } catch {
      connections = [];
    }
    const match = connections.find((c) => {
      const jwt = c?.providerSpecificData?.zcodeJwtToken;
      return typeof jwt === "string" && jwt.trim() && zcodePlanKey(c);
    });
    if (match) {
      return {
        jwt: match.providerSpecificData.zcodeJwtToken.trim(),
        planKey: zcodePlanKey(match),
        provider: match.provider,
      };
    }
  }
  return null;
}