/**
 * 应用 HTTP 服务。零依赖：node:http + 手写路由。
 * 运行时通过 Unix Socket 挂到飞牛统一网关（/app/niudao），开发时监听端口。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
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

// 成绩库统计是同步 SQLite 查询。磁盘测试（dd O_DIRECT 打满盘）期间，
// 这个查询会被卡住几秒，把整个事件循环一起拖住。缓存 5 秒，别让 /api/health 变成暗坑。
let storageCache = { at: 0, value: null };
function storageInfoCached() {
  // 体检期间不刷新：磁盘项用 dd O_DIRECT 打满盘，同步 SQLite 查询会被卡住几秒，
  // 连带把整个事件循环拖死。跑步时就用手上这份旧的（总数字晚几秒更新没关系）。
  const running = state.status === "running";
  if (!storageCache.value || (!running && Date.now() - storageCache.at > 5000)) {
    storageCache = { at: Date.now(), value: storageInfo() };
  }
  return storageCache.value;
}
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

/** 飞牛统一网关会把外部路径原样转发进来（/app/niudao/xxx），应用必须自己认这个前缀。 */
export function appPrefix() {
  return process.env.NIUDAO_PREFIX || "/app/niudao";
}

/** 把 /app/niudao/xxx 拆成 { rest: /xxx, prefix: /app/niudao }；不带前缀时 prefix 为空串。 */
export function splitPrefix(pathname) {
  const prefix = appPrefix();
  if (pathname === prefix) return { rest: "/", prefix };
  if (pathname.startsWith(`${prefix}/`)) return { rest: pathname.slice(prefix.length), prefix };
  return { rest: pathname, prefix: "" };
}

/**
 * 首页必须在**运行时**注入 <base>：
 *   走网关时 base=/app/niudao/，直连开发时 base=/。
 * 否则页面里的 styles.css / api/xxx 相对路径会解析到 NAS 根上，整页白屏
 * （第一版就是踩了这个：打开应用只看到一个大图标）。
 */
function sendIndex(res, prefix) {
  fs.readFile(path.join(WEB_DIR, "index.html"), "utf8", (err, html) => {
    if (err) return json(res, 404, { error: "资源不存在" });
    const out = html.replaceAll("__BASE__", `${prefix}/`);
    const buf = Buffer.from(out);
    res.writeHead(200, { "content-type": MIME[".html"], "content-length": buf.length, "cache-control": "no-cache" });
    res.end(buf);
  });
}

function serveStatic(res, rest, prefix = "") {
  const rel = rest === "/" ? "index.html" : rest.replace(/^\/+/, "");
  const full = path.join(WEB_DIR, path.normalize(rel));
  if (!full.startsWith(WEB_DIR)) {
    json(res, 403, { error: "非法路径" });
    return;
  }
  fs.readFile(full, (err, buf) => {
    // 单页应用：未知路径、以及 index.html 本身都走注入了 __BASE__ 的版本
    if (err || full === path.join(WEB_DIR, "index.html")) return sendIndex(res, prefix);
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
      storageCache = { at: 0, value: null };
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
          boardCache.clear(); // 自己刚交的成绩要能立刻看到

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
      storageCache = { at: 0, value: null };
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
const BOARD_TTL_MS = 30_000; // 新鲜期内切页面直接用，不劳烦网络（刷新按钮传 refresh=1 绕过）
const BOARD_STALE_MS = 7 * 24 * 3600_000; // 连不上时可以退到磁盘缓存，但要老实说是哪天抓的
const BOARD_FAILED_MS = 5 * 60_000; // 后台更新失败后，多久之内要老实告诉用户"这是旧数据"

/** 拿本机最近一次快速档成绩，用于榜单里的「我排第几」。深度档没有综合分，跳过。 */
function myBoardScore(dim) {
  const latest = getResult(state.resultId) || listResults(20).find((r) => r.kind !== "deep") || null;
  if (!latest) return null;
  return dim === "overall"
    ? latest.scores?.composite ?? latest.composite ?? null
    : latest.scores?.dims?.[dim]?.score ?? latest.dims?.[dim]?.score ?? null;
}

// /api/bootstrap 每次页面加载都会调：不能让它同步等一次 CF 往返。
// 这里只存后台保活刷出来的结果，前端拿到的永远是缓存。
let edgeHealthCache = { at: 0, value: null };
function refreshEdgeHealth() {
  if (!remote.isConfigured()) {
    edgeHealthCache = { at: Date.now(), value: { configured: false } };
    return;
  }
  remote
    .health()
    .then((value) => {
      edgeHealthCache = { at: Date.now(), value };
    })
    .catch(() => {});
}

const boardRefreshInFlight = new Set();
/** 后台偷偷把榜单拉新（stale-while-revalidate）。失败只记在缓存条目上，不打扰用户。 */
function kickBoardRefresh(cacheKey, params) {
  if (boardRefreshInFlight.has(cacheKey)) return;
  boardRefreshInFlight.add(cacheKey);
  remote
    .leaderboard(params)
    .then((data) => {
      boardCache.set(cacheKey, { at: Date.now(), data });
      persistBoardCache();
    })
    .catch((err) => {
      const cur = boardCache.get(cacheKey);
      if (cur) {
        cur.failedAt = Date.now();
        cur.lastError = String(err?.message || err);
      }
    })
    .finally(() => boardRefreshInFlight.delete(cacheKey));
}

/** 冷启动先把上次的榜单读回内存：CF 链路首次握手可能要几秒，别让用户对着空屏等。 */
function hydrateBoardCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.boardCache, "utf8"));
    for (const [key, entry] of Object.entries(raw || {})) {
      if (entry && Number.isFinite(entry.at) && entry.data) boardCache.set(key, entry);
    }
  } catch {
    /* 没缓存或格式坏了都无所谓 */
  }
}

let boardSaveTimer = null;
function persistBoardCache() {
  clearTimeout(boardSaveTimer);
  boardSaveTimer = setTimeout(() => {
    try {
      ensureDataDir();
      const dump = {};
      for (const [key, entry] of boardCache) dump[key] = entry;
      const tmp = `${PATHS.boardCache}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(dump));
      fs.renameSync(tmp, PATHS.boardCache);
    } catch (err) {
      log.warn("board_cache_save_failed", { message: String(err?.message || err) });
    }
  }, 200);
  boardSaveTimer.unref?.();
}

function humanAge(sec) {
  if (sec < 90) return `${Math.round(sec)} 秒`;
  if (sec < 5400) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 172800) return `${Math.round(sec / 3600)} 小时`;
  return `${Math.round(sec / 86400)} 天`;
}

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
      storage: storageInfoCached(),
      log: log.file(),
    });
  }

  if (pathname === "/api/metrics") {
    gauge("niudao_run_active", {}, state.status === "running" ? 1 : 0);
    gauge("niudao_uptime_seconds", {}, Math.round(process.uptime()));
    gauge("niudao_results_total", {}, storageInfoCached().total);
    gauge("niudao_memory_rss_bytes", {}, process.memoryUsage().rss);
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
    return res.end(renderPrometheus());
  }

  if (pathname === "/api/bootstrap") {
    const baseline = loadBaselines();
    // 用后台保活刷出来的那份，不再为了一次健康检查阻塞整页
    const lb = edgeHealthCache.value || { configured: remote.isConfigured(), ok: null, pending: true };
    if (Date.now() - edgeHealthCache.at > 60_000) refreshEdgeHealth();
    return json(res, 200, {
      suite: SUITE_VERSION,
      client: CLIENT_VERSION,
      baseline: { suite: baseline.suite, machine: baseline.machine, measured_at: baseline.measured_at, note: baseline.note },
      settings: loadSettings(),
      hardware: hardware(),
      leaderboard: { ...lb, official: isOfficial(loadSettings().leaderboardUrl), officialUrl: OFFICIAL_LEADERBOARD, edgeIp: remote.pinnedEdge() },
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
        boardCache.clear(); // 名次变了，下次看榜必须重新拉

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
    const force = ["1", "true"].includes(String(url.searchParams.get("refresh") || ""));
    const params = { dim, arch, limit, score: myBoardScore(dim) };
    const hit = boardCache.get(cacheKey);

    // 有缓存就先用缓存铺屏，后台再更新：CF 那条链路好坏看运气，
    // 让用户对着「载入中」等网络是没道理的。刷新按钮（refresh=1）才阻塞等待。
    if (!force && hit) {
      const ageMs = Date.now() - hit.at;
      if (ageMs >= BOARD_TTL_MS) kickBoardRefresh(cacheKey, params);
      const ageSec = Math.round(ageMs / 1000);
      const broken = hit.failedAt && Date.now() - hit.failedAt < BOARD_FAILED_MS;
      return json(res, 200, {
        mode: "remote",
        ...hit.data,
        cached: true,
        ageSec,
        revalidating: ageMs >= BOARD_TTL_MS,
        ...(broken
          ? {
              stale: true,
              warning: `排行榜暂时连不上（${hit.lastError || "网络不通"}），这是 ${humanAge(ageSec)}前的数据。体检与本地成绩不受影响。`,
            }
          : {}),
      });
    }

    try {
      const data = await remote.leaderboard(params);
      boardCache.set(cacheKey, { at: Date.now(), data });
      persistBoardCache();
      return json(res, 200, { mode: "remote", ...data });
    } catch (e) {
      const old = boardCache.get(cacheKey);
      if (old && Date.now() - old.at < BOARD_STALE_MS) {
        const ageSec = Math.round((Date.now() - old.at) / 1000);
        return json(res, 200, {
          mode: "remote",
          ...old.data,
          cached: true,
          stale: true,
          staleAgeSec: ageSec,
          warning: `排行榜暂时连不上（${String(e.message || e)}），这是 ${humanAge(ageSec)}前的数据。体检与本地成绩不受影响。`,
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
  remote.shutdown(); // 拆掉 keepAlive 连接池，否则留着 socket 不退进程
  counter("niudao_shutdown_total", { status: state.status });
  return { status: state.status, elapsedMs: Date.now() - started };
}

export function createServer() {
  return http.createServer((req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url || "/", "http://localhost");
    // 网关前缀（/app/niudao）在这里一次性剥掉，后面所有路由都按不带前缀的路径处理
    const split = splitPrefix(url.pathname);
    url.pathname = split.rest;
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
    serveStatic(res, split.rest, split.prefix);
  });
}

export function start({ port = 0, socketPath = "" } = {}) {
  initLogger(PATHS.data);

  hydrateBoardCache();

  // 启动顺序很重要：先优选 CF 边缘 IP，再预热榜单。
  // DNS 给的那两个 IP 在国内这条线路上经常建连失败，换一个同属 CF 的 anycast IP
  // 就能从 1/4 成功变成 4/4 —— 预热必须走优选的那条路，否则第一次抓榜就是白等。
  const readyToFetch = remote.isConfigured()
    ? remote
        .selectEdge()
        .then((pick) => {
          if (pick) log.info("edge_selected", { ip: pick.ip, ms: pick.ms ?? null, cached: Boolean(pick.cached), ok: pick.ok ?? null });
        })
        .catch((err) => log.warn("edge_select_failed", { message: String(err?.message || err) }))
    : Promise.resolve();

  readyToFetch.finally(() => {
    // 没有榜单缓存就先在后台抓一份：装上应用第一次点「天梯榜」不该对着转圈等
    if (remote.isConfigured() && !boardCache.has("overall||50")) {
      kickBoardRefresh("overall||50", { dim: "overall", arch: "", limit: 50, score: myBoardScore("overall") });
    }
  });

  // 预热 + 保活榜单连接。国内到 Cloudflare 的握手是随机丢包的，
  // 实测复用连接 ~400ms、新连接 0.3–15s；池子里 idle 超过 ~60s 就会退化成死连接，
  // 所以 25 秒喂一次，让绝大多数用户请求都走热连接。
  refreshEdgeHealth();
  setInterval(refreshEdgeHealth, 25_000).unref();

  // 事件循环阻塞监控：体检时如果某项把主线程卡住，页面上的进度就会停住。
  // 这个指标（+ 告警日志）用来盯住这件事，别再靠用户反馈"界面卡了"才发现。
  const loopLag = monitorEventLoopDelay({ resolution: 250 });
  loopLag.enable();
  setInterval(() => {
    const maxMs = loopLag.max / 1e6;
    const p99 = loopLag.percentile(99) / 1e6;
    gauge("niudao_event_loop_lag_ms", { kind: "p99" }, Math.round(p99 * 10) / 10);
    gauge("niudao_event_loop_lag_ms", { kind: "max" }, Math.round(maxMs * 10) / 10);
    if (maxMs > 800) {
      log.warn("event_loop_blocked", { maxMs: Math.round(maxMs), stage: state.stage || null, status: state.status });
      counter("niudao_event_loop_blocked_total", { stage: state.stage || "idle" });
    }
    loopLag.reset();
  }, 2000).unref();
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
