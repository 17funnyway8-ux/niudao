#!/usr/bin/env node
/**
 * Cloudflare 通道体检：量化「国内家宽 → CF 免费边缘」到底能用不能用。
 *
 * 背景：国内家宽到 CF 免费边缘的 TLS 握手偶有丢包，单次请求首包 2–15s。
 * 本脚本跑 N 次真实请求，对比两种客户端策略：
 *
 *   node scripts/cf-check.mjs --mode=seq      顺序重试（v1.1 之前的做法：5s 超时 ×3）
 *   node scripts/cf-check.mjs --mode=hedge    对冲重试（等 hedge 毫秒就并发再发一条）
 *   node scripts/cf-check.mjs --mode=app      复刻 remote.js 现在的策略（首条 1.5s / 后续 6s / 1.5s 对冲）
 *
 * 输出成功率与 p50/p95，用来判断「换策略能不能救」而不是靠感觉。
 *
 * 参数：
 *   --url=https://...   默认读 src/shared/endpoints.js 的 OFFICIAL_LEADERBOARD
 *   --path=/api/v1/health|/api/v1/leaderboard?dim=overall&limit=50
 *   --n=12              每组请求数
 *   --timeout=5000      单次尝试的超时
 *   --hedge=2500        对冲触发间隔（仅 hedge 模式）
 *   --attempts=3        最多并发/重试几条
 *   --ip=104.17.128.1   钉住某个 CF 边缘 IP（SNI/Host 仍是真域名），对比 DNS 给的 IP 有多差
 *   --json              只输出 JSON（给 CI 用）
 */
import https from "node:https";
import { OFFICIAL_LEADERBOARD } from "../src/shared/endpoints.js";

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  }),
);

const URL_BASE = String(argv.url || OFFICIAL_LEADERBOARD).replace(/\/+$/, "");
const PATH = String(argv.path || "/api/v1/health");
const N = Number(argv.n || 12);
const TIMEOUT = Number(argv.timeout || 5000);
const HEDGE = Number(argv.hedge || 1500);
const ATTEMPTS = Number(argv.attempts || 3);
const MODE = String(argv.mode || "app");
const FIRST_TIMEOUT = Number(argv.first || 1500);
const LATER_TIMEOUT = Number(argv.later || 6000);
const ONLY_JSON = Boolean(argv.json);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PIN_IP = String(argv.ip || "");
const AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4, scheduling: "lifo" });
/** 钉 IP 时 SNI 与 Host 仍然是真域名：证书校验、路由都不变，只是绕开 DNS 给的那个 IP。 */
const TARGET = new URL(URL_BASE + PATH);
const BASE_HOST = TARGET.hostname;
const BASE_PATH = `${TARGET.pathname}${TARGET.search}`;

function attempt(label, outer, timeoutMs = TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve({ label, ms: Date.now() - started, ...r });
      }
    };
    const req = https.request(
      {
        host: PIN_IP || BASE_HOST, // 钉住时直接连 IP
        servername: BASE_HOST,
        path: BASE_PATH,
        method: "GET",
        agent: AGENT,
        timeout: timeoutMs,
        headers: { host: BASE_HOST, accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => finish({ ok: res.statusCode === 200, status: res.statusCode, bytes: body.length }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish({ ok: false, status: 0, error: "timeout" });
    });
    req.on("error", (e) => finish({ ok: false, status: 0, error: /ECONN|ENOTFOUND|EAI_AGAIN/.test(e.message) ? "network" : e.message }));
    if (outer) outer.addEventListener("abort", () => {
      req.destroy();
      finish({ ok: false, status: 0, error: "aborted" });
    });
    req.end();
  });
}

/** 顺序重试：现有 remote.js 的做法 */
async function sequential() {
  let last = null;
  const started = Date.now();
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    last = await attempt(`try${i}`);
    if (last.ok) return { ...last, totalMs: Date.now() - started, tries: i };
    const network = last.status === 0;
    if (!network) break;
    if (i < ATTEMPTS) await sleep(300);
  }
  return { ...last, totalMs: Date.now() - started, tries: last.label };
}

/**
 * 对冲重试：先发一条，HEDGE 毫秒没结果就再并发一条，最多 ATTEMPTS 条。
 * 谁先成功用谁，其余立刻 abort（免得白占连接）。
 *
 * 关键点：不是「失败后重试」，而是「等太久就并行再问一次」。国内到 CF 的边缘
 * 丢包是随机命中某一条连接的，并发两条等于把「命中坏连接」的概率从 p 降到 p²。
 */
async function hedged() {
  const started = Date.now();
  const controllers = [];
  const hedgeTimers = [];
  const seen = [];
  let spawned = 0;
  let inflight = 0;
  let settled = false;

  return new Promise((resolve) => {
    const finish = (r) => {
      if (settled) return;
      settled = true;
      hedgeTimers.forEach(clearTimeout);
      for (const c of controllers) {
        try {
          c.abort();
        } catch {
          /* 已经结束的连接 abort 会抛，忽略 */
        }
      }
      resolve({ ...r, totalMs: Date.now() - started, tries: spawned });
    };

    const fire = () => {
      if (settled || spawned >= ATTEMPTS) return;
      spawned += 1;
      inflight += 1;
      const mine = spawned;
      const ctrl = new AbortController();
      controllers.push(ctrl);
      attempt(`try${mine}`, ctrl.signal, mine === 1 ? FIRST_TIMEOUT : LATER_TIMEOUT)
        .then((r) => {
          inflight -= 1;
          seen.push(r);
          if (r.ok) return finish(r);
          if (r.status !== 0) return finish(r); // 业务错误（4xx/5xx）：重试没意义
          if (inflight === 0 && spawned >= ATTEMPTS) return finish(r);
          return undefined;
        })
        .catch((e) => {
          inflight -= 1;
          if (inflight === 0 && spawned >= ATTEMPTS) {
            finish({ ok: false, status: 0, error: String(e?.message || e) });
          }
        });
      if (spawned < ATTEMPTS) hedgeTimers.push(setTimeout(fire, HEDGE));
    };

    fire();
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

const run = MODE === "seq" ? sequential : hedged;
const rows = [];
for (let i = 0; i < N; i += 1) {
  const r = await run();
  rows.push(r);
  if (!ONLY_JSON) {
    const flag = r.ok ? "ok  " : "FAIL";
    console.log(
      `#${String(i + 1).padStart(2)} ${flag} ${String(r.totalMs).padStart(6)}ms  status=${r.status || "-"}  tries=${r.tries}${r.error ? `  err=${r.error}` : ""}`,
    );
  }
}

const okRows = rows.filter((r) => r.ok);
const times = okRows.map((r) => r.totalMs);
const summary = {
  url: `${URL_BASE}${PATH}`,
  pinnedIp: PIN_IP || null,
  mode: MODE,
  n: N,
  timeoutMs: TIMEOUT,
  hedgeMs: MODE === "seq" ? null : HEDGE,
  firstTimeoutMs: MODE === "seq" ? TIMEOUT : FIRST_TIMEOUT,
  laterTimeoutMs: MODE === "seq" ? TIMEOUT : LATER_TIMEOUT,
  attempts: ATTEMPTS,
  ok: okRows.length,
  fail: rows.length - okRows.length,
  successRate: Math.round((okRows.length / rows.length) * 1000) / 10,
  p50ms: percentile(times, 50),
  p95ms: percentile(times, 95),
  maxMs: times.length ? Math.max(...times) : null,
  avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
  failures: rows.filter((r) => !r.ok).map((r) => r.error || `HTTP ${r.status}`),
};

AGENT.destroy();

if (ONLY_JSON) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("");
  console.log(`地址     ${summary.url}${summary.pinnedIp ? `  （钉 IP ${summary.pinnedIp}）` : "  （走 DNS）"}`);
  console.log(
    `策略     ${MODE}${
      MODE === "seq"
        ? `（顺序 ${ATTEMPTS} 次，单次 ${TIMEOUT}ms）`
        : `（首条 ${FIRST_TIMEOUT}ms、后续 ${LATER_TIMEOUT}ms，${HEDGE}ms 对冲，最多 ${ATTEMPTS} 条）`
    }`,
  );
  console.log(`成功率   ${summary.ok}/${summary.n} = ${summary.successRate}%`);
  console.log(`耗时     p50 ${summary.p50ms}ms · p95 ${summary.p95ms}ms · max ${summary.maxMs}ms · avg ${summary.avgMs}ms`);
  if (summary.failures.length) console.log(`失败     ${summary.failures.join(", ")}`);
}
