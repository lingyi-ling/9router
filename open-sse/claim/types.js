// Manual-claim ("weekend plan") types + biz-code classification — ported from
// zcode-api src/claim/types.ts.
//
// Server biz codes → failure kinds mirror the desktop client's mapper:
//   1001 notFound, 1002 unavailable, 1003 alreadyClaimed, 1004 ineligible,
//   1005 quotaExhausted, 3001 invalidRequest, 3007 captcha, 401 loginRequired.

/**
 * Map a server biz code to a client failure kind.
 * @param {number|string|undefined} code
 * @returns {string}
 */
export function classifyClaimCode(code) {
  const n = typeof code === "string" ? Number.parseInt(code, 10) : code;
  switch (n) {
    case 1001: return "not_found";
    case 1002: return "unavailable";
    case 1003: return "already_claimed";
    case 1004: return "ineligible";
    case 1005: return "quota_exhausted";
    case 3001: return "invalid_request";
    case 3007: return "captcha";
    case 401: return "login_required";
    default: return "unknown";
  }
}