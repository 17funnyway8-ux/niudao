/**
 * Cloudflare 边缘 IP 优选。
 *
 * 为什么需要这个：同一个站点走 CF，DNS 只会给该 zone 分配的那几个 anycast IP
 * （我们的域名是 104.21.41.26 / 172.67.159.18）。实测这两个 IP 在国内某条宽带上
 * TCP 建连失败率极高（4 次里挂 3 次），而同一条线路访问 CF 的其它 anycast IP
 * （104.17.x）4/4 成功、单次 0.5s。
 *
 * anycast 的好处是：任何 CF 边缘 IP 都能服务任何挂在 CF 上的站点，
 * 只要 TLS SNI 和 HTTP Host 还是我们的域名。所以客户端可以自己挑一个走得通的 IP，
 * 证书照样校验通过、路由照样到我们的 Worker —— 这就是俗称的「CF 优选 IP」。
 *
 * 做法：启动时并发探测一小池候选 IP（每个 2s 超时），谁先给出正确的
 * /api/v1/health 就钉谁；钉住之后连不上会自动重探，选择结果落盘，重启不重探。
 */
import dns from "node:dns";
import fs from "node:fs";
import https from "node:https";

/**
 * 候选池：取自 CF 公布的 anycast 网段（104.16.0.0/13、172.64.0.0/13、188.114.96.0/20）。
 * 不是"越靠前越好"，顺序无所谓 —— 每次都是谁快用谁。
 */
export const CANDIDATES = [
  "104.17.128.1", // 本机实测最优（4/4，~0.55s）
  "104.17.0.1",
  "104.18.0.1",
  "104.19.0.1",
  "104.20.0.1",
  "104.22.0.1",
  "104.23.0.1",
  "172.66.0.1",
  "172.68.0.1",
  "188.114.96.1",
];

const FAILS_BEFORE_REPROBE = 3;
const REPROBE_COOLDOWN_MS = 60_000;

let pinnedIp = null;
let pinnedHost = "";
let stateFile = "";
let consecutiveFails = 0;
let lastProbeAt = 0;
let probing = null;

export function configureEdge({ host = "", file = "" } = {}) {
  pinnedHost = String(host || "");
  stateFile = String(file || "");
}

export function pinnedEdge() {
  return pinnedIp;
}

/** 只有"官方榜主机名"才会被钉 IP；用户配的自建地址一律按 DNS 走。 */
export function shouldPin(hostname) {
  return Boolean(pinnedIp && pinnedHost && hostname === pinnedHost);
}

/** 供 https.Agent 用的自定义 lookup：命中就返回钉住的 IP，否则走正常 DNS。 */
export function lookup(hostname, options, callback) {
  const opts = typeof options === "number" ? { family: options } : options || {};
  if (shouldPin(hostname)) {
    if (opts.all) return callback(null, [{ address: pinnedIp, family: 4 }]);
    return callback(null, pinnedIp, 4);
  }
  return dns.lookup(hostname, opts, callback);
}

export function loadChoice() {
  pinnedIp = null;
  if (!stateFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    // 只认"同一主机名"的选择：换了官方榜地址，旧 IP 必须作废
    if (raw?.host === pinnedHost && raw?.ip) {
      pinnedIp = String(raw.ip);
      return pinnedIp;
    }
  } catch {
    /* 没有或坏了都重探 */
  }
  return null;
}

function saveChoice(ip) {
  if (!stateFile) return;
  try {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ host: pinnedHost, ip, at: Date.now() }, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch {
    /* 落盘失败不影响运行 */
  }
}

export function clearChoice() {
  pinnedIp = null;
}

/** 探测单个 IP：SNI/Host 用真域名，必须拿到自家 /api/v1/health 的正确响应才算数。 */
export function probeIp(ip, { host = pinnedHost, timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve({ ip, ms: Date.now() - started, ...r });
      }
    };
    const req = https.request(
      {
        host: ip,
        servername: host,
        path: "/api/v1/health",
        method: "GET",
        agent: false,
        timeout: timeoutMs,
        headers: { host, accept: "application/json", connection: "close" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (body.length > 4000) req.destroy();
        });
        res.on("end", () => {
          const ok = res.statusCode === 200 && body.includes('"ok":true');
          finish({ ok, status: res.statusCode, error: ok ? undefined : `HTTP ${res.statusCode}` });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => finish({ ok: false, error: e.message }));
    req.end();
  });
}

/** 并发探测整池，取最快的那个；全都不行返回 null（那就老老实实走 DNS）。 */
export async function chooseEdge({ candidates = CANDIDATES, timeoutMs = 2000 } = {}) {
  if (!pinnedHost) return null;
  if (probing) return probing;
  lastProbeAt = Date.now();
  probing = (async () => {
    const results = await Promise.all(candidates.map((ip) => probeIp(ip, { timeoutMs })));
    const good = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
    if (!good.length) return null;
    pinnedIp = good[0].ip;
    consecutiveFails = 0;
    saveChoice(pinnedIp);
    return { ip: pinnedIp, ms: good[0].ms, tried: results.length, ok: good.length };
  })();
  try {
    return await probing;
  } finally {
    probing = null;
  }
}

/** 每次网络失败调一下：连续失败够了就清掉钉子并重探（异步，不阻塞本次请求）。 */
export function noteFailure() {
  consecutiveFails += 1;
  if (consecutiveFails < FAILS_BEFORE_REPROBE) return;
  consecutiveFails = 0;
  if (Date.now() - lastProbeAt < REPROBE_COOLDOWN_MS) return;
  chooseEdge().catch(() => {});
}

export function noteSuccess() {
  consecutiveFails = 0;
}
