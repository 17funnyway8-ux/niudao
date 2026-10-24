/**
 * 牛刀天梯 · Cloudflare Workers 版
 *
 * 与自托管版（leaderboard/server.js）保持同一套 HTTP 契约，客户端不用改：
 *   GET  /api/v1/health
 *   POST /api/v1/submit
 *   GET  /api/v1/leaderboard?dim=&arch=&limit=&offset=&score=
 *   GET  /api/v1/stats
 *   GET  /api/v1/machine/:fingerprint
 *   DELETE /api/v1/entry/:id          （需 ADMIN_TOKEN）
 *   GET  /                             公开榜单页
 *   POST /api/feedback                用户反馈（含脱敏日志）
 *
 * 设计取舍：只收原始指标，分数一律服务端重算；排名用 D1 的 COUNT + OFFSET 现算，
 * 不维护冗余排名表（家用/社区规模足够，省掉一致性问题）。
 */
import { validateSubmission } from "../../src/shared/schema.js";
import { handleFeedback } from "./feedback.js";
import { SUITE_VERSION, computeScores, gradeOf } from "../../src/shared/scoring.js";
import { baselines as baselinesFile, pageHtml } from "./assets.js";
import {
  bucketsOf,
  countOf,
  entriesOf,
  medianStats,
  previousEntry,
  recentByFingerprint,
  removeEntry,
  upsertEntry,
} from "./store.js";

const MIN_SAMPLES = 30;

/** 榜单对外只暴露这些硬件信息，卷路径与磁盘挂载点一律不外发 */
function publicHardware(hw) {
  const h = hw || {};
  return {
    cpu_model: h.cpu_model || "",
    cores: h.cores || 0,
    threads: h.threads || 0,
    mem_gb: h.mem_gb || 0,
    mem_gib: h.mem_gib ?? null,
    os_version: h.os_version || "",
    kernel: h.kernel || "",
    board: h.board || "",
    gpu: h.gpu || "",
  };
}

/** 和自托管端保持同一套规则：花名 + 指纹前 8 位，用于区分同名机器 */
function nameKeyOf(alias, fingerprint) {
  return `${String(alias || "").trim().toLowerCase()}#${String(fingerprint || "").slice(0, 8)}`;
}
const DIMS = { overall: "composite", cpu: "cpu", memory: "memory", storage: "storage" };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

const html = () =>
  new Response(pageHtml, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (pathname === "/api/v1/health") return await health(env);
      if (pathname === "/api/feedback" || pathname.startsWith("/api/feedback/")) return await handleFeedback(request, env, url);
      if (pathname === "/api/v1/submit" && request.method === "POST") return await submit(request, env);
      if (pathname === "/api/v1/leaderboard") return await leaderboard(url, env);
      if (pathname === "/api/v1/stats") return await stats(env);
      const machine = pathname.match(/^\/api\/v1\/machine\/([a-f0-9]+)$/i);
      if (machine) return await machineHistory(machine[1], env);
      const entry = pathname.match(/^\/api\/v1\/entry\/([\w-]+)$/);
      if (entry && request.method === "DELETE") return await remove(entry[1], request, env);
      if (pathname.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
      return html();
    } catch (err) {
      return json({ error: String(err?.message || err) }, 500);
    }
  },
};

/* --------------------------------------------------------------- handlers */

async function health(env) {
  const machines = await countOf(env.DB, {});
  return json({
    ok: true,
    service: "niudao-leaderboard-worker",
    version: 1,
    suite: SUITE_VERSION,
    baselinesSuite: baselinesFile.suite,
    machines,
  });
}

async function submit(request, env) {
  const body = await request.json().catch(() => null);
  const check = validateSubmission(body);
  if (!check.ok) return json({ error: check.errors.join("；"), errors: check.errors }, 400);

  const v = check.value;
  if (v.suite !== SUITE_VERSION) {
    return json({ error: `套件版本不一致：服务端 v${SUITE_VERSION}，你交的是 v${v.suite}` }, 409);
  }

  const prev = await previousEntry(env.DB, v.fingerprint, v.suite);
  const scores = computeScores(v.metrics, baselinesFile.metrics);

  // 防刷分：同一台机器 12 小时内只接受一次写入；除非提升超过 3%。
  // 没写进去的时候不是报错，而是明确告诉客户端"保留了原成绩"——重跑跑出更差的分数不该弹红字。
  if (prev) {
    const elapsedH = (Date.now() - (prev.received_at || prev.ts || 0)) / 3600000;
    const improvedEnough = scores.composite > prev.composite * 1.03;
    if (elapsedH < 12 && !improvedEnough) {
      const ahead = await countOf(env.DB, { suite: v.suite, arch: v.arch, above: prev.composite });
      return json({
        ok: true,
        kept: true,
        improved: false,
        composite: scores.composite,
        previousBest: prev.composite,
        rank: ahead + 1,
        retryAfterH: Math.round((12 - elapsedH) * 10) / 10,
        message:
          scores.composite <= prev.composite
            ? `本次 ${scores.composite} 分未超过已有最好成绩 ${prev.composite}，已保留原成绩。`
            : `距上次提交 ${elapsedH.toFixed(1)} 小时，提升不足 3%，已保留原成绩（${prev.composite}）。`,
      });
    }
  }

  const entry = {
    id: crypto.randomUUID(),
    ts: v.ts,
    received_at: Date.now(),
    suite: v.suite,
    client: v.client,
    fingerprint: v.fingerprint,
    arch: v.arch,
    alias: v.alias,
    hardware: v.hardware,
    metrics: v.metrics,
    scores,
    composite: scores.composite,
    cpu: scores.dims.cpu?.score ?? null,
    memory: scores.dims.memory?.score ?? null,
    storage: scores.dims.storage?.score ?? null,
    caveats: v.caveats,
  };
  await upsertEntry(env.DB, entry);

  const total = await countOf(env.DB, { suite: v.suite, arch: v.arch });
  const ahead = await countOf(env.DB, { suite: v.suite, arch: v.arch, above: scores.composite });
  const rank = ahead + 1;

  return json({
    ok: true,
    id: entry.id,
    composite: scores.composite,
    grade: gradeOf(scores.composite).grade,
    rank,
    percentile: total >= MIN_SAMPLES ? Math.round(((total - rank + 0.5) / total) * 1000) / 10 : null,
    total,
    improved: !prev || scores.composite > prev.composite,
    previousBest: prev ? prev.composite : null,
    minSamples: MIN_SAMPLES,
    sampleGated: total < MIN_SAMPLES,
    scores,
  });
}

async function leaderboard(url, env) {
  const dim = url.searchParams.get("dim") || "overall";
  if (!DIMS[dim]) return json({ error: "dim 不支持" }, 400);
  const arch = url.searchParams.get("arch") || "";
  // 同型号筛选：unknown / 空型号不参与（否则所有识别失败的虚机会被聚成"同一个型号"）
  const cpuRaw = (url.searchParams.get("cpu") || "").slice(0, 120);
  const cpu = /^(unknown|未知|-+|)$/i.test(cpuRaw.trim()) ? "" : cpuRaw;
  const suite = url.searchParams.get("suite") || SUITE_VERSION;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const scoreRaw = url.searchParams.get("score");
  const score = scoreRaw === null ? null : Number(scoreRaw);

  const where = { suite, arch, cpu };
  const total = await countOf(env.DB, where);
  const rows = await entriesOf(env.DB, { ...where, dim: DIMS[dim], limit, offset });
  // 重名处理：花名只是显示名。dup 用来把"同名的另一个人的成绩"和"我的成绩"分开，
  // isMine 由调用方传入的 id（本机最近一次上榜的条目）比对得出。
  const mineId = (url.searchParams.get("mine") || "").slice(0, 64);
  const entries = rows.map((r, i) => ({
    rank: offset + i + 1,
    id: r.id,
    alias: r.alias || "",
    nameKey: nameKeyOf(r.alias, r.fingerprint),
    isMine: Boolean(mineId) && r.id === mineId,
    value: r[DIMS[dim]],
    composite: r.composite,
    arch: r.arch,
    ts: r.ts,
    suite: r.suite,
    // 只给「看得懂硬件」需要的字段。volume（测试卷的真实路径）和 disks（挂载点与容量）
    // 是算分用的，不是给别人看的 —— 上一版把整份 hardware 原样返回，等于把用户的
    // 目录结构和磁盘布局贴到公网上。宁可少给，不可多给。
    hardware: publicHardware(JSON.parse(r.hardware)),
  }));
  // 重名检测：按"花名"计数（不是 nameKey —— 那里面含指纹，按它数永远是 1）。
  // 只在这一页范围内判断足够用：页外同名对用户体验影响很小。
  const counts = new Map();
  const aliasOf = (e) => String(e.alias || "").trim().toLowerCase();
  for (const e of entries) counts.set(aliasOf(e), (counts.get(aliasOf(e)) || 0) + 1);
  for (const e of entries) e.dup = (counts.get(aliasOf(e)) || 0) > 1;

  const median = await medianStats(env.DB, { ...where, dim: DIMS[dim] });
  const buckets = await bucketsOf(env.DB, { ...where, dim: DIMS[dim] });

  let me = null;
  if (Number.isFinite(score)) {
    const ahead = await countOf(env.DB, { ...where, above: score });
    const equal = await countOf(env.DB, { ...where, equal: score });
    const rank = ahead + 1;
    const [aboveRow] = await entriesOf(env.DB, { ...where, dim: DIMS[dim], limit: 1, offset: Math.max(0, ahead - 1), gt: score });
    const [belowRow] = await entriesOf(env.DB, { ...where, dim: DIMS[dim], limit: 1, offset: 0, lt: score });
    me = {
      rank,
      value: score,
      total,
      percentile: total >= MIN_SAMPLES ? Math.round(((ahead + equal * 0.5) / total) * 1000) / 10 : null,
      above: aboveRow ? { rank: ahead, value: aboveRow[DIMS[dim]], alias: aboveRow.alias, hardware: JSON.parse(aboveRow.hardware) } : null,
      below: belowRow
        ? { rank: ahead + equal + 1, value: belowRow[DIMS[dim]], alias: belowRow.alias, hardware: JSON.parse(belowRow.hardware) }
        : null,
    };
  }

  return json({
    mode: "remote",
    dim,
    suite,
    arch: arch || null,
    cpu: cpu || null,
    total,
    offset,
    limit,
    entries,
    me,
    buckets,
    stats: {
      n: total,
      median: median.median,
      ci: median.ci,
      gated: total < MIN_SAMPLES,
      needed: total < MIN_SAMPLES ? MIN_SAMPLES - total : 0,
    },
  });
}

async function stats(env) {
  return json({ ok: true, suite: SUITE_VERSION, machines: await countOf(env.DB, {}) });
}

async function machineHistory(fingerprint, env) {
  const list = await recentByFingerprint(env.DB, fingerprint);
  return json({
    total: list.length,
    entries: list.map((e) => ({ id: e.id, ts: e.ts, composite: e.composite, suite: e.suite, metrics: JSON.parse(e.metrics) })),
  });
}

async function remove(id, request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: "服务端未配置 ADMIN_TOKEN，删除入口已关闭" }, 403);
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (auth !== env.ADMIN_TOKEN) return json({ error: "令牌不对" }, 403);
  const deleted = await removeEntry(env.DB, id);
  return json({ deleted });
}
