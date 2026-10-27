#!/usr/bin/env node
/**
 * 牛刀天梯服务（自托管）。零依赖，一条命令起：
 *   node leaderboard/server.js --port 8790 [--data ./leaderboard/data]
 * 环境变量：LB_ADMIN_TOKEN（删除入口）、LB_PORT、LB_DATA
 *
 * 关键设计：客户端只提交原始指标，分数一律这里用同一套 baselines 重算。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MIN_SAMPLES, Store, nameKey } from "./store.js";
import { validateSubmission } from "../src/shared/schema.js";
import { SUITE_VERSION, computeScores, gradeOf } from "../src/shared/scoring.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(process.env.LB_PORT || arg("--port", "8790"));
/**
 * 监听地址。**默认只监听本机**。
 *
 * 原来写死 0.0.0.0 —— 在只有内网的环境里没问题，但这套服务经常被部署到
 * 有公网 IP 的机器（家里的 PVE、带 EIP 的云主机）上，0.0.0.0 等于把榜单
 * 直接挂到公网上，既没有 TLS 也没有任何鉴权。
 *
 * 需要局域网内其它机器直接访问时，显式加 --host 0.0.0.0 或设 LB_HOST=0.0.0.0。
 * 走 Cloudflare Tunnel 时保持默认即可（隧道连的就是 127.0.0.1）。
 */
const HOST = process.env.LB_HOST || arg("--host", "127.0.0.1");
const DATA_DIR = process.env.LB_DATA || arg("--data", path.join(HERE, "data"));
const ADMIN_TOKEN = process.env.LB_ADMIN_TOKEN || "";
const BASELINE_FILE = process.env.LB_BASELINES || arg("--baselines", path.join(HERE, "baselines.json"));

const baselines = (() => {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    console.error(`[lb] 缺少基准文件 ${BASELINE_FILE}，拒绝启动（否则无法校验分数）`);
    process.exit(1);
  }
})();

/**
 * 基准版本必须和套件版本一致，否则算出来的分数是错的。
 *
 * 真实事故：PVE 上第一次部署的包里带的是旧基准（mem_copy 8.69，来自一次错误改动），
 * 而套件已经是 1.3.0。服务端拿旧基准重算客户端提交的原始指标，
 * 把本该 988 分的成绩算成了 1932 分，还因为"分数更高"占住了榜首位，
 * 后续真实成绩反而顶不掉它。
 *
 * 客户端和服务端各带一份 baselines.json，这是分发包的固有形态 ——
 * 所以必须在启动时把版本对齐这件事变成硬约束，而不是静默用错基准。
 */
if (baselines.suite !== SUITE_VERSION) {
  console.error(
    `[lb] 基准文件版本与套件版本不一致，拒绝启动：\n` +
      `     基准 baselines.suite = ${baselines.suite}\n` +
      `     套件 SUITE_VERSION  = ${SUITE_VERSION}\n` +
      `     用错基准算分会给出错误的排名（曾把 988 分算成 1932）。\n` +
      `     请用与客户端同版本的 baselines.json 重新部署。`,
  );
  process.exit(1);
}

const store = new Store(path.join(DATA_DIR, "submissions.jsonl"));

/* ---------------- 简易限流 ---------------- */
const buckets = new Map();
function rateLimit(ip, key, limit, windowMs) {
  const now = Date.now();
  const id = `${ip}|${key}`;
  const b = buckets.get(id);
  if (!b || now - b.start > windowMs) {
    buckets.set(id, { start: now, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

/** 服务端复核运行环境，判据同 Worker 端（见 worker/src/index.js 注释） */
function serverEnvOverride(hardware) {
  const hay = [hardware?.board, hardware?.cpu_model, hardware?.gpu, hardware?.os_version].filter(Boolean).join(" ");
  if (/qemu|kvm|proxmox|vmware|virtualbox|innotek|parallels|xen|hyper-?v|microsoft corporation|bochs|virtual machine/i.test(hay)) {
    return "vm";
  }
  if (hardware?.hypervisorFlag === true) return "vm";
  const board = String(hardware?.board || "").trim();
  const osv = String(hardware?.osVersion || hardware?.os_version || "");
  const foreignOs = /debian|ubuntu|centos|alpine|arch linux|fedora|instabox|openwrt|buildroot/i.test(osv);
  if (!board && foreignOs) return "container";
  return null;
}

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "content-length": buf.length,
  });
  res.end(buf);
};

function readBody(req, limit = 96 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

/**
 * 根路径只回 API 说明，不渲染榜单网页。
 * 和官方 Worker 保持一致：查看榜单统一走飞牛应用内的天梯，
 * 免得同一个问题有两套界面、两个答案。
 */
function servePublic(res) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  return res.end(
    JSON.stringify(
      {
        service: "niudao-leaderboard (self-hosted)",
        message: "牛刀天梯只提供 API。查看榜单请在飞牛 fnOS 中打开「牛刀」应用的天梯页。",
        endpoints: {
          leaderboard: "GET /api/v1/leaderboard?dim=overall&track=physical&arch=&limit=50",
          health: "GET /api/v1/health",
          submit: "POST /api/v1/submit",
        },
      },
      null,
      2,
    ),
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const { pathname } = url;
  const ip = clientIp(req);

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      });
      return res.end();
    }

    if (pathname === "/api/v1/health") {
      return json(res, 200, {
        ok: true,
        service: "niudao-leaderboard",
        version: 1,
        suite: SUITE_VERSION,
        baselinesSuite: baselines.suite,
        ...store.stats(),
      });
    }

    if (pathname === "/api/v1/submit" && req.method === "POST") {
      if (!rateLimit(ip, "submit", 12, 3600_000)) return json(res, 429, { error: "提交太频繁，歇一会儿" });
      const body = await readBody(req);
      const check = validateSubmission({ ...body, __envOverride: serverEnvOverride });
      if (!check.ok) return json(res, 400, { error: check.errors.join("；"), errors: check.errors });

      const v = check.value;
      if (v.suite !== SUITE_VERSION) {
        return json(res, 409, {
          error: `套件版本不一致：服务端 v${SUITE_VERSION}，你交的是 v${v.suite}。请升级到同一版本再提交。`,
        });
      }

      // 防刷分：同一台机器 12 小时内只接受一次写入；除非提升超过 3%。
      // 没写进去时返回 kept=true（不是错误），客户端据此提示"保留原成绩"。
      const prevEntry = [...store.best.values()].find((e) => e.fingerprint === v.fingerprint && e.suite === v.suite);
      const scores = computeScores(v.metrics, baselines.metrics);
      if (prevEntry) {
        const elapsedH = (Date.now() - (prevEntry.receivedAt || prevEntry.ts || 0)) / 3600000;
        const improvedEnough = scores.composite > prevEntry.scores.composite * 1.03;
        if (elapsedH < 12 && !improvedEnough) {
          const better = prevEntry.scores.composite;
          return json(res, 200, {
            ok: true,
            kept: true,
            improved: false,
            composite: scores.composite,
            previousBest: better,
            retryAfterH: Math.round((12 - elapsedH) * 10) / 10,
            message:
              scores.composite <= better
                ? `本次 ${scores.composite} 分未超过已有最好成绩 ${better}，已保留原成绩。`
                : `距上次提交 ${elapsedH.toFixed(1)} 小时，提升不足 3%，已保留原成绩（${better}）。`,
          });
        }
      }
      const entry = {
        id: randomUUID(),
        ts: v.ts,
        receivedAt: Date.now(),
        suite: v.suite,
        client: v.client,
        fingerprint: v.fingerprint,
        arch: v.arch,
        alias: v.alias,
        hardware: v.hardware,
        metrics: v.metrics,
        scores,
        grade: gradeOf(scores.composite),
        caveats: v.caveats,
      };
      const key = `${entry.fingerprint}|${entry.suite}`;
      const prev = store.best.get(key);
      store.add(entry);

      const board = store.leaderboard({ dim: "overall", suite: v.suite, arch: v.arch, limit: 1, score: scores.composite });
      return json(res, 200, {
        ok: true,
        id: entry.id,
        composite: scores.composite,
        grade: entry.grade.grade,
        rank: board.me?.rank ?? null,
        percentile: board.me?.percentile ?? null,
        total: board.total,
        improved: !prev || scores.composite > prev.scores.composite,
        previousBest: prev ? prev.scores.composite : null,
        minSamples: MIN_SAMPLES,
        sampleGated: board.total < MIN_SAMPLES,
        scores,
      });
    }

    if (pathname === "/api/v1/leaderboard") {
      const dim = url.searchParams.get("dim") || "overall";
      if (!["overall", "cpu", "memory", "storage"].includes(dim)) return json(res, 400, { error: "dim 不支持" });
      const arch = url.searchParams.get("arch") || "";
      const cpu = (url.searchParams.get("cpu") || "").slice(0, 120);
      const trackRaw = url.searchParams.get("track") || "physical";
      const track = ["physical", "vm", "all"].includes(trackRaw) ? trackRaw : "physical";
      const fp = (url.searchParams.get("fp") || "").slice(0, 64);
      const suite = url.searchParams.get("suite") || SUITE_VERSION;
      /**
       * 旧套件的客户端主动告知它要看的榜。
       *
       * 2.9.0~2.9.4 那批已分发的包不会自动升级，它们会一直用 suite=1.1.0 来查榜，
       * 而服务端已经是 1.3.0 —— 查出来的永远是空榜，用户只会觉得"榜单坏了"。
       * 这里明确回 426 Upgrade Required 并在 error 里说清楚，客户端的
       * 「连不上榜单」提示框会原样显示这句话，用户就知道该升级了。
       *
       * 为什么不用 200 + 空榜：那等于让用户永远看着一个空页面，还以为是我们挂了。
       */
      if (suite && suite !== SUITE_VERSION) {
        return json(res, 426, {
          error: `你的牛刀是旧版本（套件 ${suite}），当前榜单是套件 ${SUITE_VERSION}。测量方法已修正，旧成绩作废，请更新到最新版本后重跑一次。`,
          serverSuite: SUITE_VERSION,
          clientSuite: suite,
        });
      }
      const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const scoreRaw = url.searchParams.get("score");
      const score = scoreRaw === null ? null : Number(scoreRaw);
      const data = store.leaderboard({ dim, suite, arch, cpu, track, limit, offset, fingerprint: fp, score: Number.isFinite(score) ? score : null });
      return json(res, 200, { mode: "remote", ...data });
    }

    if (pathname === "/api/v1/stats") {
      return json(res, 200, { ok: true, suite: SUITE_VERSION, ...store.stats() });
    }

    const machineMatch = pathname.match(/^\/api\/v1\/machine\/([a-f0-9]+)$/i);
    if (machineMatch) {
      const list = store.byFingerprint(machineMatch[1]);
      return json(res, 200, {
        total: list.length,
        entries: list.map((e) => ({ id: e.id, ts: e.ts, composite: e.scores.composite, suite: e.suite, metrics: e.metrics })),
      });
    }

    const delMatch = pathname.match(/^\/api\/v1\/entry\/([\w-]+)$/);
    if (delMatch && req.method === "DELETE") {
      if (!ADMIN_TOKEN) return json(res, 403, { error: "服务端未配置 LB_ADMIN_TOKEN，删除入口已关闭" });
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (auth !== ADMIN_TOKEN) return json(res, 403, { error: "令牌不对" });
      return json(res, 200, { deleted: store.remove(delMatch[1]) });
    }

    if (pathname.startsWith("/api/")) return json(res, 404, { error: "接口不存在" });
    return servePublic(res);
  } catch (err) {
    return json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[lb] 牛刀天梯服务 http://${HOST}:${PORT}  (数据: ${DATA_DIR} / 套件 v${SUITE_VERSION})`);
  console.log(`[lb] 已收录 ${store.best.size} 台机器、${store.all.length} 条提交`);
});
