// Aliyun captcha solver dispatch — ported from zcode-api src/proxy/captcha-solver.ts
// (+ src/proxy/captcha.ts token entry).
//
// The in-process happy-dom solver that drives the official Aliyun "traceless
// verification" JS ships as `open-sse/captcha/happyDomSolver.js` — a verbatim
// port of zcode-api src/proxy/captcha-happy.ts with TypeScript types stripped
// via the TypeScript compiler API (no logic changes). It needs the
// `happy-dom` + `undici` dependencies.
//
// Backends, in priority order:
//   1. `ZCODE_CAPTCHA_SOLVER_URL` — an external solver accepting
//      `POST {scene, region, prefix}` → `{ verifyParam, region? }`.
//   2. In-process happy-dom solver (default when happy-dom is installed).
//
// `getCaptchaToken` returns the verify-param the claim request needs; the claim
// scheduler backs off on failure.

const DEFAULT_SCENE = "11xygtvd";
const DEFAULT_REGION = "sgp";
const DEFAULT_PREFIX = "1c";

export class CaptchaSolverUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaptchaSolverUnavailableError";
  }
}

/**
 * Acquire an Aliyun verify-param for the claim request.
 * @param {{scene?:string, region?:string, prefix?:string}} [opts]
 * @returns {Promise<{verifyParam:string, region?:string}>}
 */
export async function getCaptchaToken(opts = {}) {
  const scene = opts.scene || process.env.ZCODE_CAPTCHA_SCENE || DEFAULT_SCENE;
  const region = opts.region || process.env.ZCODE_CAPTCHA_REGION || DEFAULT_REGION;
  const prefix = opts.prefix || process.env.ZCODE_CAPTCHA_PREFIX || DEFAULT_PREFIX;

  const external = process.env.ZCODE_CAPTCHA_SOLVER_URL?.trim();
  if (external) return solveViaExternal(external, { scene, region, prefix });

  const inProcess = await loadInProcessSolver();
  if (inProcess) return inProcess({ scene, region, prefix });

  throw new CaptchaSolverUnavailableError(
    "no Aliyun captcha solver available. Install happy-dom (in-process solver), " +
    "or set ZCODE_CAPTCHA_SOLVER_URL to an external solver.",
  );
}

async function solveViaExternal(baseUrl, { scene, region, prefix }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/solve`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scene, region, prefix }),
    signal: AbortSignal.timeout(Number(process.env.ZCODE_CAPTCHA_TIMEOUT_MS || 60_000)),
  });
  if (!resp.ok) throw new Error(`captcha solver HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data?.verifyParam || typeof data.verifyParam !== "string") {
    throw new Error("captcha solver returned no verifyParam");
  }
  return { verifyParam: data.verifyParam, region: data.region || region };
}

/** Load the in-process happy-dom solver; null when the dependency is absent. */
async function loadInProcessSolver() {
  try {
    const mod = await import("./happyDomSolver.js");
    const solve = mod?.solveTraceless;
    if (typeof solve !== "function") return null;
    return async ({ scene, region, prefix }) => {
      const verifyParam = await solve({ scene, region, prefix });
      return { verifyParam, region };
    };
  } catch {
    return null;
  }
}