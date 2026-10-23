/** 排行榜（自托管服务）客户端。没配置地址时全部降级为本地模式。 */
import { CLIENT_VERSION, SUITE_VERSION } from "../shared/scoring.js";
import { loadSettings } from "./settings.js";

// 国内家宽到 Cloudflare 免费边缘的 TLS 握手偶有丢包（实测首包 2–8s），
// 所以：单次 6 秒超时 + 最多重试 2 次；连接会被 undici 复用，重试通常很快。
const TIMEOUT = 5000;
const ATTEMPTS = 3;

function baseUrl() {
  const { leaderboardUrl } = loadSettings();
  const url = (leaderboardUrl || "").trim().replace(/\/+$/, "");
  return url;
}

async function callOnce(pathname, { method = "GET", body, token } = {}, base) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/** 带重试的调用。只对网络层失败重试，HTTP 4xx/5xx 直接抛（那是业务错误，重试没意义）。 */
async function call(pathname, opts = {}) {
  const base = baseUrl();
  if (!base) throw new Error("NO_LEADERBOARD");
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await callOnce(pathname, opts, base);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isNetwork = err?.name === "TimeoutError" || /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(msg);
      if (!isNetwork || attempt === ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

export function isConfigured() {
  return Boolean(baseUrl());
}

export async function health() {
  if (!isConfigured()) return { configured: false };
  try {
    const info = await call("/api/v1/health");
    return { configured: true, ok: true, ...info };
  } catch (err) {
    return { configured: true, ok: false, error: String(err.message || err) };
  }
}

export async function submit(result, alias) {
  const settings = loadSettings();
  const payload = {
    suite: SUITE_VERSION,
    client: CLIENT_VERSION,
    fingerprint: result.fingerprint,
    arch: result.arch,
    alias: alias ?? settings.alias,
    hardware: result.hardware,
    metrics: result.metrics,
    durations: result.durations,
    caveats: result.caveats,
    ts: result.ts,
  };
  return call("/api/v1/submit", { method: "POST", body: payload, token: settings.leaderboardToken });
}

export async function leaderboard({ dim = "overall", arch = "", limit = 50, offset = 0, score = null } = {}) {
  const q = new URLSearchParams({ dim, limit: String(limit), offset: String(offset) });
  if (arch) q.set("arch", arch);
  if (Number.isFinite(score)) q.set("score", String(score));
  return call(`/api/v1/leaderboard?${q.toString()}`);
}

export async function stats({ dim = "overall", arch = "" } = {}) {
  const q = new URLSearchParams({ dim });
  if (arch) q.set("arch", arch);
  return call(`/api/v1/stats?${q.toString()}`);
}

export async function machineHistory(fingerprint) {
  return call(`/api/v1/machine/${encodeURIComponent(fingerprint)}`);
}
