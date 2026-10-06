// Aliyun captcha solver dispatch — ported (abstraction only) from zcode-api
// src/proxy/captcha-solver.ts + captcha.ts.
//
// The reference ships a 100 KB in-process happy-dom solver that drives the
// official Aliyun "traceless verification" JS (see captcha-happy.ts). That blob
// depends on happy-dom internals, sync-XHR worker + SharedArrayBuffer plumbing,
// undici ProxyAgent, and the Bun compiled-binary environment — it is NOT ported
// here.
//
// 9router exposes two pluggable backends instead:
//   1. `ZCODE_CAPTCHA_SOLVER_URL` — an external solver (e.g. the reference
//      zcode-api run as a local captcha oracle) that accepts
//      `POST {scene, region, prefix}` → `{ verifyParam, region? }`.
//   2. In-process happy-dom solver — enabled only when `happy-dom` is installed
//      AND `open-sse/captcha/happyDomSolver.js` exists (not shipped by default).
//
// When neither is available, `getCaptchaToken` throws a clear, actionable error
// so the claim scheduler backs off instead of silently failing.

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
    "no Aliyun captcha solver available. Set ZCODE_CAPTCHA_SOLVER_URL to an external solver, " +
    "or ship open-sse/captcha/happyDomSolver.js with happy-dom installed.",
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

async function loadInProcessSolver() {
  // Optional local module; absent by default (the happy-dom blob is not shipped).
  try {
    const mod = await import("./happyDomSolver.js");
    return mod?.solveCaptcha || mod?.default || null;
  } catch {
    return null;
  }
}