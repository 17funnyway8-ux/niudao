/**
 * 排行榜客户端（对公网地址，默认是 Cloudflare Workers 上的官方榜）。
 *
 * 国内家宽到 CF 免费边缘的握手是**随机丢包**的：新连接首包 0.3–15s，复用连接 ~0.4s。
 * 所以这里的策略不是「失败后重试」，而是三件事：
 *
 *  1. 长连接池：keepAliveMsecs 30s，正常情况一次看榜只花一个 RTT（~400ms）；
 *  2. 对冲（hedged）：3.5s 没回来就并发再发一条，谁先回用谁，其余立刻掐掉
 *     —— 把「命中坏连接」的概率从 p 降到 p²；
 *  3. 业务错误（4xx/5xx）不重试，网络错误立刻补发（不等定时器）。
 *
 * 实测（本机家宽，2026-10-24，各 10 次）：
 *   顺序重试 5s×3 → 成功率 90%，p50 3212ms
 *   对冲 2.5s×3   → 成功率 100%，p50 830ms
 * 可用 `node scripts/cf-check.mjs --mode=seq|hedge` 复现。
 */
import http from "node:http";
import https from "node:https";
import { CLIENT_VERSION, SUITE_VERSION } from "../shared/scoring.js";
import { OFFICIAL_LEADERBOARD } from "../shared/endpoints.js";
import * as edge from "./edge.js";
import { PATHS, loadSettings } from "./settings.js";

/**
 * 超时不是拍脑袋定的，是量出来的（2026-10-24，本机家宽 → fnbench.1133891.xyz）：
 *  - 复用连接健康时一次请求 ~400ms；
 *  - 复用连接「半死」（中间设备把状态丢了）时，请求会一直挂着不动，只能靠超时兜；
 *  - 新连接要重做 TLS 握手，成功率 ~30–50%，成功的那些耗时 2.4–7s。
 * 所以第一条给短超时（踩到死连接就快点换路），后续几条给足 6s 让新握手有机会完成。
 */
const FIRST_TIMEOUT = 1500;
const LATER_TIMEOUT = 6000;
/** 第一条没动静多久就并发补一条 */
const HEDGE_DELAY = 1500;
/** 最多同时/累计发几条 */
const MAX_ATTEMPTS = 3;

/**
 * 长连接池：按协议各一个，别每次请求都重新握手。
 * https 的 lookup 换成 edge.lookup —— 官方榜可以钉在优选出来的 CF 边缘 IP 上
 * （SNI/Host 仍然是域名，证书与路由都不受影响）。详见 edge.js 的注释。
 */
const AGENTS = {
  "http:": new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4, scheduling: "lifo" }),
  "https:": new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 4,
    scheduling: "lifo",
    lookup: edge.lookup,
  }),
};

/** 官方榜的 hostname；只有它允许钉边缘 IP，用户自建地址一律按 DNS 走。 */
function officialHost() {
  try {
    return new URL(OFFICIAL_LEADERBOARD).hostname;
  } catch {
    return "";
  }
}

function baseUrl() {
  const { leaderboardUrl } = loadSettings();
  return (leaderboardUrl || "").trim().replace(/\/+$/, "");
}

/**
 * 发一次请求。返回 { promise, cancel }，cancel 用来在对手先赢时掐掉这条。
 * 只用 node:http(s)，不依赖 undici —— 这样才能自己控制 keepAlive 时长。
 */
function requestOnce(url, { method = "GET", body, token } = {}, timeoutMs = LATER_TIMEOUT) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  let req = null;
  let settle = () => {};

  const promise = new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const agent = AGENTS[u.protocol] || AGENTS["https:"];
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    settle = (err) => finish(reject, err);

    req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method,
        agent,
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("aborted", () => {
          const err = new Error("连接被中断");
          err.name = "NetworkError";
          finish(reject, err);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { raw: text.slice(0, 400) };
          }
          const status = res.statusCode || 0;
          if (status >= 400) {
            const err = new Error(data?.error || data?.message || `HTTP ${status}`);
            err.status = status;
            err.business = true; // 业务错误：重试没意义
            return finish(reject, err);
          }
          return finish(resolve, data);
        });
      },
    );

    const timer = setTimeout(() => {
      const err = new Error(`超时 ${timeoutMs}ms`);
      err.name = "TimeoutError";
      req?.destroy(err);
      finish(reject, err);
    }, timeoutMs);

    req.on("error", (err) => {
      if (err?.name === "AbortError") return;
      if (!err.name) err.name = "NetworkError";
      finish(reject, err);
    });

    if (payload) req.write(payload);
    req.end();
  });

  return {
    promise,
    cancel: () => {
      try {
        if (req && !req.destroyed) {
          const err = new Error("aborted");
          err.name = "AbortError";
          req.destroy(err);
          settle(err);
        }
      } catch {
        /* 已结束 */
      }
    },
  };
}

/** 对冲执行：先发一条，超时未回就并发补发，第一个成功的结果胜出。 */
async function race(fn) {
  return new Promise((resolve, reject) => {
    let spawned = 0;
    let inflight = 0;
    let settled = false;
    const cancels = [];
    const timers = [];
    let lastErr = null;

    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      for (const c of cancels) c();
      if (ok) resolve(value);
      else reject(value);
    };

    const fire = () => {
      if (settled || spawned >= MAX_ATTEMPTS) return;
      spawned += 1;
      inflight += 1;
      const handle = fn();
      cancels.push(handle.cancel);
      handle.promise
        .then((data) => {
          inflight -= 1;
          edge.noteSuccess();
          finish(true, data);
        })
        .catch((err) => {
          inflight -= 1;
          lastErr = err;
          if (!err?.business) edge.noteFailure();
          if (err?.business) return finish(false, err); // 4xx/5xx：不重试
          if (inflight === 0 && spawned < MAX_ATTEMPTS) return fire(); // 秒失败：立刻补发
          if (inflight === 0) return finish(false, err);
          return undefined;
        });
      if (spawned < MAX_ATTEMPTS) timers.push(setTimeout(fire, HEDGE_DELAY));
    };

    fire();
    // 兜底：所有定时器都被清理时的最后一道闸
    timers.push(
      setTimeout(() => {
        if (!settled) finish(false, lastErr || new Error("排行榜无响应"));
      }, HEDGE_DELAY * (MAX_ATTEMPTS - 1) + LATER_TIMEOUT + 500),
    );
  });
}

async function call(pathname, opts = {}) {
  const base = baseUrl();
  if (!base) throw new Error("NO_LEADERBOARD");
  const url = `${base}${pathname}`;
  let n = 0;
  return race(() => requestOnce(url, opts, n++ === 0 ? FIRST_TIMEOUT : LATER_TIMEOUT));
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

/** 保活：只为了不让连接池里的 TCP/TLS 会话饿死，失败无所谓。 */
export function keepWarm() {
  if (!isConfigured()) return;
  call("/api/v1/health").catch(() => {});
}

export async function submit(result, alias) {
  const settings = loadSettings();
  const payload = {
    suite: SUITE_VERSION,
    client: CLIENT_VERSION,
    fingerprint: result.fingerprint,
    arch: result.arch,
    alias: alias ?? settings.alias,
    // 卷路径是用户自己的目录结构，公共榜上不需要，别带出去
    hardware: (() => {
      const { volume, ...rest } = result.hardware || {};
      return rest;
    })(),
    metrics: result.metrics,
    durations: result.durations,
    caveats: result.caveats,
    ts: result.ts,
  };
  return call("/api/v1/submit", { method: "POST", body: payload, token: settings.leaderboardToken });
}

export async function leaderboard({ dim = "overall", arch = "", cpu = "", limit = 50, offset = 0, score = null } = {}) {
  const q = new URLSearchParams({ dim, limit: String(limit), offset: String(offset) });
  if (arch) q.set("arch", arch);
  if (cpu) q.set("cpu", cpu);
  if (Number.isFinite(score)) q.set("score", String(score));
  return call(`/api/v1/leaderboard?${q.toString()}`);
}

export async function stats({ dim = "overall", arch = "" } = {}) {
  const q = new URLSearchParams({ dim });
  if (arch) q.set("arch", arch);
  return call(`/api/v1/stats?${q.toString()}`);
}

/**
 * 优选边缘 IP：只对官方榜有效。启动时调一次（后台跑，不阻塞服务起来），
 * 之后由 noteFailure() 触发重探。返回 {ip, ms} 或 null（全都不通就走 DNS）。
 */
export async function selectEdge() {
  if (process.env.NIUDAO_EDGE === "off") return null; // 测试/离线环境别去探测公网
  const base = baseUrl();
  if (!base) return null;
  let host = "";
  try {
    host = new URL(base).hostname;
  } catch {
    return null;
  }
  if (host !== officialHost()) return null;
  edge.configureEdge({ host, file: PATHS.edge });
  if (edge.loadChoice()) return { ip: edge.pinnedEdge(), ms: null, cached: true };
  return edge.chooseEdge();
}

/** 当前钉住的边缘 IP（没钉返回 null），给 /api/health 显示用。 */
export function pinnedEdge() {
  return edge.pinnedEdge();
}

/** 关服务时把连接池拆掉，否则 keepAlive 的 socket 会拖着进程不退。 */
export function shutdown() {
  for (const agent of Object.values(AGENTS)) {
    try {
      agent.destroy();
    } catch {
      /* 忽略 */
    }
  }
}
