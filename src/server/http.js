/**
 * 应用 HTTP 服务。零依赖：node:http + 手写路由。
 * 运行时通过 Unix Socket 挂到飞牛统一网关（/app/niudao），开发时监听端口。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { snapshot } from "./hardware.js";
import { STAGES, runSuite } from "./runner.js";
import { DEEP_LIMITS, normalizeDuration, runDeep } from "./deep.js";
import { appendResult, deleteResult, getResult, listResults, localRank, pageResults, storageInfo, updateResult } from "./store.js";
import { counter, gauge, observe, renderPrometheus } from "./metrics.js";
import { initLogger, log } from "./log.js";
import { buildCard, buildMarkdown } from "./report.js";
import { PATHS, loadBaselines, loadSettings, saveSettings, TARGET_DIR, ensureDataDir } from "./settings.js";
import * as remote from "./remote.js";
import { CLIENT_VERSION, DIMENSIONS, METRICS, SUITE_VERSION, computeScores, gradeOf } from "../shared/scoring.js";
import { OFFICIAL_LEADERBOARD, isOfficial } from "../shared/endpoints.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = [path.join(HERE, "web"), path.resolve(HERE, "..", "web")].find((p) => fs.existsSync(p)) || path.join(HERE, "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const state = {
  status: "idle",
  kind: null, // "fast" | "deep"
  stage: null,
  phase: null,
  index: 0,
  total: STAGES.length,
  startedAt: 0,
  finishedAt: 0,
  error: null,
  events: [],
  live: null, // 深度档的实时采样点
  progress: null, // 深度档进度 {burnedSec, remainingSec, durationSec}
  resultId: null,
  cancelRequested: false,
};

let hwCache = { at: 0, value: null };
function hardware(force = false) {
  if (!force && hwCache.value && Date.now() - hwCache.at < 30_000) return hwCache.value;
  hwCache = { at: Date.now(), value: snapshot({ targetDir: TARGET_DIR }) };
  return hwCache.value;
}

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": buf.length });
  res.end(buf);
};

function readBody(req, limit = 128 * 1024) {
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

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = path.join(WEB_DIR, path.normalize(rel));
  if (!full.startsWith(WEB_DIR)) {
    json(res, 403, { error: "非法路径" });
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      // 单页应用：未知路径回落到 index.html
      fs.readFile(path.join(WEB_DIR, "index.html"), (e2, html) => {
        if (e2) return json(res, 404, { error: "资源不存在" });
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(buf);
  });
}

function localLeaderboard(dim, limit = 50) {
  const all = [];
  for (const r of listResults(500)) {
    if (r.kind === "deep") continue; // 深度档没有综合分，不进性能榜
    const value = dim === "overall" ? r.composite : r.dims?.[dim]?.score;
    if (Number.isFinite(value)) all.push({ ...r, value });
  }
  all.sort((a, b) => b.value - a.value);
  return {
    mode: "local",
    dim,
    total: all.length,
    limit,
    entries: all.slice(0, limit).map((e, i) => ({
      rank: i + 1,
      id: e.id,
      alias: "",
      value: e.value,
      composite: e.composite,
      arch: e.arch,
      ts: e.ts,
      hardware: { cpu_model: e.cpu_model, mem_gb: null },
    })),
  };
}

async function startRun(body = {}) {
  if (state.status === "running") {
    const err = new Error("已有测试在运行");
    err.status = 409;
    throw err;
  }
  const settings = loadSettings();
  const target = body.targetDir || settings.targetDir || TARGET_DIR;
  ensureDataDir();

  Object.assign(state, {
    status: "running",
    kind: "fast",
    stage: null,
    phase: null,
    index: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    error: null,
    events: [],
    live: null,
    progress: null,
    resultId: null,
    cancelRequested: false,
  });

  log.info("run_start", { kind: "fast", target });
  const hw = hardware(true);
  const opts = {
    diskSizeMb: Number(body.diskSizeMb) || settings.diskSizeMb || 512,
    diskFileMb: Number(body.diskFileMb) || 512,
    shouldStop: () => state.cancelRequested,
  };

  (async () => {
    try {
      const run = await runSuite({
        targetDir: target,
        opts,
        onEvent: (ev) => {
          if (ev.type === "stage") {
            state.stage = ev.stage;
            state.index = ev.index;
            state.events.push({ at: Date.now(), ...ev });
            if (state.events.length > 60) state.events.shift();
          }
        },
      });

      const baseline = loadBaselines();
      const scores = computeScores(run.metrics, baseline.metrics);
      const grade = gradeOf(scores.composite);
      const result = {
        id: randomUUID(),
        ts: Date.now(),
        suite: SUITE_VERSION,
        client: CLIENT_VERSION,
        fingerprint: hw.fingerprint,
        arch: hw.arch,
        hostname: hw.hostname,
        hardware: { ...hw.hardware, volume: target },
        metrics: run.metrics,
        scores,
        grade,
        durations: run.durations,
        detail: run.detail,
        caveats: [...run.caveats, ...run.errors.map((e) => `未完成的测试：${e}`)],
        errors: run.errors,
        wallMs: run.wallMs,
        env: { thermals: hw.thermals, loadavg: hw.loadavg, uptime_hours: hw.uptime_hours },
        baselineSuite: baseline.suite,
      };
      appendResult(result);
      state.status = run.cancelled ? "cancelled" : "done";
      state.finishedAt = Date.now();
      state.resultId = result.id;
      state.events.push({ at: Date.now(), type: "finished", resultId: result.id, status: state.status });
      log.info("run_done", {
        kind: "fast",
        status: state.status,
        composite: scores.composite,
        wallMs: run.wallMs,
        errors: run.errors.length,
      });

      if (settings.autoSubmit && settings.leaderboardUrl) {
        try {
          await remote.submit(result, settings.alias);
          updateResult(result.id, { submitted: true, submittedAt: Date.now() });
        } catch (e) {
          state.events.push({ at: Date.now(), type: "submit-error", message: String(e.message || e) });
        }
      }
    } catch (err) {
      state.status = "error";
      state.finishedAt = Date.now();
      state.error = String(err?.message || err);
      state.events.push({ at: Date.now(), type: "error", message: state.error });
      log.error("run_error", { kind: "fast", message: state.error });
    }
  })();

  return { started: true };
}

/** 深度档：烤机 + 温度/频率曲线 + 降频判定。不参与综合分，单独入档。 */
async function startDeep(body = {}) {
  if (state.status === "running") {
    const err = new Error("已有测试在运行");
    err.status = 409;
    throw err;
  }
  const settings = loadSettings();
  const target = body.targetDir || settings.targetDir || TARGET_DIR;
  const durationSec = normalizeDuration(body.durationSec ?? DEEP_LIMITS.defaultSec);
  const loadDisk = Boolean(body.loadDisk);
  ensureDataDir();

  Object.assign(state, {
    status: "running",
    kind: "deep",
    stage: null,
    phase: "baseline",
    index: 0,
    startedAt: Date.now(),
    finishedAt: 0,
    error: null,
    events: [],
    live: null,
    progress: { durationSec, burnedSec: 0, remainingSec: durationSec },
    resultId: null,
    cancelRequested: false,
  });

  log.info("run_start", { kind: "deep", target, durationSec, loadDisk });
  const hw = hardware(true);

  (async () => {
    try {
      const run = await runDeep({
        targetDir: target,
        durationSec,
        loadDisk,
        shouldStop: () => state.cancelRequested,
        onEvent: (ev) => {
          if (ev.type === "phase") state.phase = ev.phase;
          if (ev.type === "phase") state.events.push({ at: Date.now(), ...ev });
          if (ev.type === "tick") {
            state.live = ev.sample;
            state.progress = { durationSec, burnedSec: ev.burnedSec, remainingSec: ev.remainingSec };
          }
          if (ev.type === "sample") state.live = { ...ev.sample };
          if (state.events.length > 80) state.events.shift();
        },
      });

      const result = {
        id: randomUUID(),
        ts: Date.now(),
        kind: "deep",
        suite: SUITE_VERSION,
        client: CLIENT_VERSION,
        fingerprint: hw.fingerprint,
        arch: hw.arch,
        hostname: hw.hostname,
        hardware: { ...hw.hardware, volume: target },
        stability: run.stability,
        series: run.series,
        rounds: run.rounds,
        preMops: run.preMops,
        postMops: run.postMops,
        burnedSec: run.burnedSec,
        wallMs: run.wallMs,
        loadDisk,
        caveats: run.stability.notes,
      };
      appendResult(result);
      state.status = run.cancelled ? "cancelled" : "done";
      state.phase = "done";
      state.finishedAt = Date.now();
      state.resultId = result.id;
      state.progress = { durationSec, burnedSec: run.burnedSec, remainingSec: 0 };
      state.events.push({ at: Date.now(), type: "finished", resultId: result.id, status: state.status });
      log.info("run_done", {
        kind: "deep",
        status: state.status,
        verdict: run.stability?.verdict?.level,
        stabilityPct: run.stability?.stability?.pct ?? null,
        burnedSec: run.burnedSec,
      });
    } catch (err) {
      state.status = "error";
      state.finishedAt = Date.now();
      state.error = String(err?.message || err);
      state.events.push({ at: Date.now(), type: "error", message: state.error });
      log.error("run_error", { kind: "deep", message: state.error });
    }
  })();

  return { started: true, kind: "deep", durationSec };
}

// 榜单纯读缓存：CF 这条链路偶尔要几秒，短时间内重复看榜不该每次都等网络
const boardCache = new Map(); // key -> { at, data }
const BOARD_TTL_MS = 30_000;
const BOARD_STALE_MS = 10 * 60_000;

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || "GET";

  if (pathname === "/api/health") {
    const uptimeSec = Math.round(process.uptime());
    return json(res, 200, {
      ok: true,
      suite: SUITE_VERSION,
      client: CLIENT_VERSION,
      status: state.status,
      kind: state.kind,
      uptimeSec,
      storage: storageInfo(),
      log: log.file(),
    });
  }

  if (pathname === "/api/metrics") {
    gauge("niudao_run_active", {}, state.status === "running" ? 1 : 0);
    gauge("niudao_uptime_seconds", {}, Math.round(process.uptime()));
    gauge("niudao_results_total", {}, storageInfo().total);
    gauge("niudao_memory_rss_bytes", {}, process.memoryUsage().rss);
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
    return res.end(renderPrometheus());
  }

  if (pathname === "/api/bootstrap") {
    const baseline = loadBaselines();
    const lb = await remote.health();
    return json(res, 200, {
      suite: SUITE_VERSION,
      client: CLIENT_VERSION,
      baseline: { suite: baseline.suite, machine: baseline.machine, measured_at: baseline.measured_at, note: baseline.note },
      settings: loadSettings(),
      hardware: hardware(),
      leaderboard: { ...lb, official: isOfficial(loadSettings().leaderboardUrl), officialUrl: OFFICIAL_LEADERBOARD },
      history: listResults(30),
      run: state,
      stages: STAGES,
      dimensions: DIMENSIONS,
      metrics: METRICS,
      deepLimits: DEEP_LIMITS,
      lastDeep: listResults(60).find((r) => r.kind === "deep") || null,
      localRank: (() => {
        const latestFast = listResults(20).find((r) => r.kind !== "deep");
        return latestFast ? localRank(latestFast.composite) : null;
      })(),
    });
  }

  if (pathname === "/api/hardware") return json(res, 200, hardware(url.searchParams.get("force") === "1"));

  if (pathname === "/api/run" && method === "GET") return json(res, 200, state);

  if (pathname === "/api/run" && method === "POST") {
    try {
      const body = await readBody(req);
      const out = await startRun(body);
      return json(res, 202, out);
    } catch (e) {
      return json(res, e.status || 400, { error: String(e.message || e) });
    }
  }

  if (pathname === "/api/run/cancel" && method === "POST") {
    state.cancelRequested = true;
    return json(res, 200, { cancelling: true });
  }

  if (pathname === "/api/deep/run" && method === "POST") {
    try {
      const body = await readBody(req);
      const out = await startDeep(body);
      return json(res, 202, out);
    } catch (e) {
      return json(res, e.status || 400, { error: String(e.message || e) });
    }
  }

  if (pathname === "/api/settings" && method === "GET") return json(res, 200, loadSettings());

  if (pathname === "/api/settings" && method === "POST") {
    const body = await readBody(req);
    const patch = {};
    for (const key of ["alias", "leaderboardUrl", "leaderboardToken", "autoSubmit", "targetDir"]) {
      if (key in body) patch[key] = body[key];
    }
    if ("diskSizeMb" in body) patch.diskSizeMb = Math.max(64, Math.min(4096, Number(body.diskSizeMb) || 512));
    if (patch.leaderboardUrl && !/^https?:\/\//i.test(String(patch.leaderboardUrl))) {
      return json(res, 400, { error: "排行榜地址必须以 http:// 或 https:// 开头" });
    }
    if (patch.targetDir) {
      // 校验用户填的目录：必须是已存在、可写、是目录。
      // 注意：绝不能对用户输入的路径做 recursive mkdir —— 某些文件系统（如 procfs）的 mkdir
      // 返回 ENOENT，会让 Node 的递归建目录陷入死循环，直接把整个事件循环卡死。
      const dir = String(patch.targetDir);
      if (!path.isAbsolute(dir)) {
        return json(res, 400, { error: "测试目录必须是绝对路径，例如 /vol1/@appdata/niudao" });
      }
      let stat = null;
      try {
        stat = fs.statSync(dir);
      } catch {
        return json(res, 400, { error: `测试目录不存在：${dir}（请先创建，或换成已存在的卷目录）` });
      }
      if (!stat.isDirectory()) return json(res, 400, { error: `不是目录：${dir}` });
      try {
        fs.accessSync(dir, fs.constants.W_OK);
      } catch {
        return json(res, 400, { error: `测试目录不可写：${dir}（应用以 niudao 用户运行，请给它写权限）` });
      }
      const probe = path.join(dir, ".niudao-probe");
      try {
        fs.writeFileSync(probe, "ok");
        fs.rmSync(probe, { force: true });
      } catch (e) {
        return json(res, 400, { error: `测试目录写入失败：${dir}（${e.code || e.message}）` });
      }
      patch.targetDir = dir;
    }
    const next = saveSettings(patch);
    hwCache = { at: 0, value: null };
    return json(res, 200, next);
  }

  if (pathname === "/api/results" && method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const before = Number(url.searchParams.get("before")) || null;
    return json(res, 200, pageResults({ limit, before }));
  }

  const resultMatch = pathname.match(/^\/api\/results\/([A-Za-z0-9._-]+)(?:\/(submit|report\.md|export\.json|card))?$/);
  if (resultMatch) {
    const [, id, action] = resultMatch;
    const result = getResult(id);
    if (!result) return json(res, 404, { error: "找不到这次成绩" });

    if (!action && method === "GET") return json(res, 200, result);
    if (!action && method === "DELETE") return json(res, 200, { deleted: deleteResult(id) });

    if (action === "report.md") {
      const md = buildMarkdown(result);
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
      return res.end(md);
    }
    if (action === "export.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="niudao-${id.slice(0, 8)}.json"`,
      });
      return res.end(JSON.stringify(result, null, 2));
    }
    if (action === "card") return json(res, 200, { text: buildCard(result) });

    if (action === "submit" && method === "POST") {
      if ((result.kind || "fast") === "deep") {
        return json(res, 400, { error: "稳定性成绩不参与性能榜（它测的是持续性能，不是算力）" });
      }
      const body = await readBody(req);
      try {
        const out = await remote.submit(result, body.alias);
        updateResult(id, { submitted: true, submittedAt: Date.now() });
        return json(res, 200, out);
      } catch (e) {
        const msg = String(e.message || e);
        const hint = msg === "NO_LEADERBOARD" ? "还没有配置排行榜地址（设置 → 排行服务器）" : msg;
        return json(res, 502, { error: hint });
      }
    }
    return json(res, 405, { error: "方法不允许" });
  }

  if (pathname === "/api/leaderboard") {
    const dim = url.searchParams.get("dim") || "overall";
    const arch = url.searchParams.get("arch") || "";
    const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);
    if (!remote.isConfigured()) {
      const local = localLeaderboard(dim, limit);
      const latest = listResults(1)[0];
      return json(res, 200, {
        ...local,
        me: latest ? { id: latest.id, value: latest.composite, rank: local.entries.findIndex((e) => e.id === latest.id) + 1 || null } : null,
      });
    }
    const cacheKey = `${dim}|${arch}|${limit}`;
    try {
      // 取最近一次「快速档」成绩来算"我排第几"（深度档没有综合分）
      const latest =
        getResult(state.resultId) ||
        listResults(20).find((r) => r.kind !== "deep") ||
        null;
      const score = latest
        ? dim === "overall"
          ? latest.scores?.composite ?? latest.composite ?? null
          : latest.scores?.dims?.[dim]?.score ?? latest.dims?.[dim]?.score ?? null
        : null;
      const data = await remote.leaderboard({ dim, arch, limit, score });
      boardCache.set(cacheKey, { at: Date.now(), data });
      return json(res, 200, { mode: "remote", ...data });
    } catch (e) {
      const hit = boardCache.get(cacheKey);
      if (hit && Date.now() - hit.at < BOARD_STALE_MS) {
        return json(res, 200, {
          mode: "remote",
          ...hit.data,
          stale: true,
          staleAgeSec: Math.round((Date.now() - hit.at) / 1000),
          warning: `排行榜暂时连不上（${String(e.message || e)}），这是 ${Math.round((Date.now() - hit.at) / 1000)} 秒前的数据。`,
        });
      }
      return json(res, 200, {
        mode: "remote",
        dim,
        arch: arch || null,
        total: 0,
        offset: 0,
        limit,
        entries: [],
        me: null,
        buckets: {},
        stats: null,
        unavailable: true,
        warning: `排行榜暂时连不上（${String(e.message || e)}）。检查网络后点「刷新」；体检与本地成绩不受影响。`,
      });
    }
  }

  if (pathname === "/api/stats") {
    if (!remote.isConfigured()) return json(res, 200, { mode: "local", total: listResults(500).length });
    try {
      return json(res, 200, { mode: "remote", ...(await remote.stats({ arch: url.searchParams.get("arch") || "" })) });
    } catch (e) {
      return json(res, 502, { error: String(e.message || e) });
    }
  }

  return json(res, 404, { error: "接口不存在" });
}

/** 优雅关闭：把正在跑的测试停干净，别留下半条数据和一堆 worker。 */
export async function shutdown({ timeoutMs = 8000 } = {}) {
  const started = Date.now();
  if (state.status === "running") {
    state.cancelRequested = true;
    while (state.status === "running" && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (state.status === "running") {
      state.status = "interrupted";
      state.error = "服务被停止，本次测试中断（已保存部分结果）";
    }
  }
  log.info("shutdown", { status: state.status, elapsedMs: Date.now() - started });
  counter("niudao_shutdown_total", { status: state.status });
  return { status: state.status, elapsedMs: Date.now() - started };
}

export function createServer() {
  return http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url || "/", "http://localhost");
    const isApi = url.pathname.startsWith("/api/");

    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const route = url.pathname.replace(/\/api\/results\/[\w.-]+/, "/api/results/:id");
      counter("niudao_http_requests_total", { method: req.method, route, status: res.statusCode });
      observe("niudao_http_duration_ms", { route }, ms);
      if (isApi) {
        log.debug("http", { method: req.method, route, status: res.statusCode, ms: Math.round(ms) });
      }
    });

    if (isApi) {
      handleApi(req, res, url).catch((err) => {
        log.error("api_error", { route: url.pathname, message: String(err?.message || err) });
        counter("niudao_api_errors_total", { route: url.pathname });
        if (!res.headersSent) json(res, 500, { error: String(err?.message || err) });
      });
      return;
    }
    serveStatic(res, url.pathname);
  });
}

export function start({ port = 0, socketPath = "" } = {}) {
  initLogger(PATHS.data);

  // 预热榜单连接：国内到 Cloudflare 的首包握手偶发丢包，开机就先握一次手；
  // 之后每 3 分钟再来一次，避免连接池彻底冷掉。
  const warm = () => remote.health().catch(() => {});
  warm();
  setInterval(warm, 180_000).unref();
  process.on("uncaughtException", (err) => {
    log.error("uncaught_exception", { message: String(err?.message || err), stack: String(err?.stack || "").slice(0, 800) });
    counter("niudao_process_errors_total", { kind: "uncaughtException" });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled_rejection", { message: String(reason?.message || reason) });
    counter("niudao_process_errors_total", { kind: "unhandledRejection" });
  });
  const server = createServer();
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port, socketPath });
    };
    if (socketPath) {
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {
        /* ignore */
      }
      server.listen(socketPath, done);
    } else {
      server.listen(port, "0.0.0.0", done);
    }
  });
}

export { PATHS };
