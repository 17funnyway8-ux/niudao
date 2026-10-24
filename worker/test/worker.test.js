/**
 * Worker 集成测试：用 node:sqlite 造一个 D1 适配层，直接调用 worker 的 fetch 处理函数。
 * 好处是不依赖 wrangler / 网络，跑得和单测一样快；SQL 与 D1 语义一致（都是 SQLite）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

/* ------------------------------------------------ D1 → node:sqlite 适配层 */

function makeD1(sqlite) {
  const stmt = (sql) => {
    const prepared = sqlite.prepare(sql);
    const api = {
      bind(...values) {
        return {
          async all() {
            return { results: prepared.all(...values) };
          },
          async first() {
            return prepared.get(...values) ?? null;
          },
          async run() {
            const info = prepared.run(...values);
            return { meta: { changes: Number(info.changes) } };
          },
        };
      },
      async all() {
        return { results: prepared.all() };
      },
      async first() {
        return prepared.get() ?? null;
      },
      async run() {
        const info = prepared.run();
        return { meta: { changes: Number(info.changes) } };
      },
    };
    return api;
  };
  return { prepare: stmt };
}

function freshEnv(adminToken = "") {
  const db = new DatabaseSync(":memory:");
  const schema = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  db.exec(schema);
  return { DB: makeD1(db), ADMIN_TOKEN: adminToken, __db: db };
}

const worker = (await import("../src/index.js")).default;
const { SUITE_VERSION } = await import("../../src/shared/scoring.js");
const { baselines } = await import("../src/assets.js");

const call = async (env, pathname, init = {}) =>
  worker.fetch(new Request(`https://lb.test${pathname}`, init), env);

const jsonBody = async (res) => ({ status: res.status, body: await res.json() });

let seq = 0;
function submission({ fp, alias = "", arch = "x64", mult = 1, metrics, cpuModel } = {}) {
  seq += 1;
  const m =
    metrics ||
    Object.fromEntries(Object.entries(baselines.metrics).map(([k, v]) => [k, k === "mem_latency" ? v / mult : v * mult]));
  const sub = {
    suite: SUITE_VERSION,
    client: "1.0.0",
    fingerprint: fp || String(seq).padStart(16, "0"),
    arch,
    alias,
    hardware: { cpu_model: cpuModel || `Test CPU ${seq}`, cores: 4, threads: 8, mem_gb: 16, os_version: "1.2.0401", kernel: "6.1" },
    metrics: m,
    ts: 1700000000000 + seq,
  };
  return sub;
}

const post = (env, body) =>
  call(env, "/api/v1/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* --------------------------------------------------------------- 测试 */

test("健康检查与公开页", async () => {
  const env = freshEnv();
  const h = await jsonBody(await call(env, "/api/v1/health"));
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.suite, SUITE_VERSION);
  const page = await call(env, "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /牛刀天梯/);
});

test("提交：服务端重算分数，返回名次与样本门槛", async () => {
  const env = freshEnv();
  const r = await jsonBody(await post(env, submission({ fp: "aaaa1111aaaa1111", alias: "小王" })));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.composite, 1000, "基准机指标应算出 1000");
  assert.equal(r.body.rank, 1);
  assert.equal(r.body.percentile, null, "样本不足不给百分位");
  assert.equal(r.body.sampleGated, true);
});

test("同一台机器只保留最好成绩，且 12 小时内不许重复刷", async () => {
  const env = freshEnv();
  const fp = "bbbb2222bbbb2222";
  await post(env, submission({ fp, mult: 1 }));
  const worse = await jsonBody(await post(env, submission({ fp, mult: 0.8 })));
  assert.equal(worse.status, 200);
  assert.equal(worse.body.kept, true, "更差的成绩不写库，但也不算错误");
  assert.equal(worse.body.previousBest, 1000);
  const marginal = await jsonBody(await post(env, submission({ fp, mult: 1.01 })));
  assert.equal(marginal.body.kept, true, "提升不足 3% 同样保留原成绩");
  const board = await jsonBody(await call(env, "/api/v1/leaderboard?dim=overall"));
  assert.equal(board.body.total, 1, "一台机器只占一行");
  assert.equal(board.body.entries[0].composite, 1000, "保留的是最好那条");
});

test("非法指标 / 版本不一致被拒", async () => {
  const env = freshEnv();
  const bad = submission({ fp: "cccc3333cccc3333" });
  bad.metrics.disk_rand_read = 9e12;
  assert.equal((await jsonBody(await post(env, bad))).status, 400);

  const wrongSuite = submission({ fp: "dddd4444dddd4444" });
  wrongSuite.suite = "0.0.1";
  assert.equal((await jsonBody(await post(env, wrongSuite))).status, 409);
});

test("排序、名次、前后邻位与百分位", async () => {
  const env = freshEnv();
  const mks = [0.5, 1, 1.5, 2];
  for (let i = 0; i < mks.length; i += 1) {
    await post(env, submission({ fp: String(i + 10).padStart(16, "0"), mult: mks[i] }));
  }
  const board = await jsonBody(await call(env, "/api/v1/leaderboard?dim=overall&score=1000"));
  assert.equal(board.body.total, 4);
  assert.deepEqual(board.body.entries.map((e) => e.rank), [1, 2, 3, 4]);
  assert.equal(board.body.entries[0].value, 2000);
  assert.equal(board.body.me.rank, 3);
  assert.equal(board.body.me.percentile, null);
  assert.equal(board.body.me.above.value, 1500);
  assert.equal(board.body.me.below.value, 500);
  assert.equal(board.body.stats.gated, true);
  assert.equal(board.body.stats.needed, 26);
});

test("样本达到 30 台后给百分位与置信区间", async () => {
  const env = freshEnv();
  for (let i = 0; i < 30; i += 1) {
    await post(env, submission({ fp: String(i).padStart(16, "0"), mult: 0.5 + (i / 30) * 1.5 }));
  }
  const board = await jsonBody(await call(env, "/api/v1/leaderboard?dim=overall&score=1000"));
  assert.equal(board.body.total, 30);
  assert.equal(board.body.stats.gated, false);
  assert.ok(board.body.me.percentile > 0 && board.body.me.percentile < 100);
  assert.equal(board.body.stats.ci.length, 2);
  assert.ok(board.body.stats.ci[0] <= board.body.stats.median);
});

test("按维度排序：CPU 榜与总榜顺序不同", async () => {
  const env = freshEnv();
  // 一台 CPU 强存储弱，一台反过来
  const strongCpu = submission({ fp: "1111222233334444", metrics: { ...baselines.metrics, cpu_multi: baselines.metrics.cpu_multi * 3, disk_rand_read: 100 } });
  const strongDisk = submission({ fp: "5555666677778888", metrics: { ...baselines.metrics, cpu_multi: baselines.metrics.cpu_multi * 0.5, disk_rand_read: baselines.metrics.disk_rand_read * 3 } });
  await post(env, strongCpu);
  await post(env, strongDisk);
  const cpu = await jsonBody(await call(env, "/api/v1/leaderboard?dim=cpu"));
  const storage = await jsonBody(await call(env, "/api/v1/leaderboard?dim=storage"));
  assert.equal(cpu.body.entries[0].arch, "x64");
  assert.notEqual(cpu.body.entries[0].id, storage.body.entries[0].id, "两个维度的第一名应不同");
});

test("架构隔离：ARM 单独成榜", async () => {
  const env = freshEnv();
  await post(env, submission({ fp: "aaaa0000aaaa0000", arch: "x64" }));
  await post(env, submission({ fp: "bbbb0000bbbb0000", arch: "arm64", mult: 0.4 }));
  assert.equal((await jsonBody(await call(env, "/api/v1/leaderboard?arch=x64"))).body.total, 1);
  assert.equal((await jsonBody(await call(env, "/api/v1/leaderboard?arch=arm64"))).body.total, 1);
});

test("单机历史与管理员删除", async () => {
  const env = freshEnv("secret-token");
  const r = await jsonBody(await post(env, submission({ fp: "9999000099990000" })));
  const hist = await jsonBody(await call(env, "/api/v1/machine/9999000099990000"));
  assert.equal(hist.body.total, 1);
  assert.equal(hist.body.entries[0].composite, 1000);

  const noToken = await call(env, `/api/v1/entry/${r.body.id}`, { method: "DELETE" });
  assert.equal(noToken.status, 403);
  const wrong = await call(env, `/api/v1/entry/${r.body.id}`, { method: "DELETE", headers: { authorization: "Bearer nope" } });
  assert.equal(wrong.status, 403);
  const ok = await jsonBody(await call(env, `/api/v1/entry/${r.body.id}`, { method: "DELETE", headers: { authorization: "Bearer secret-token" } }));
  assert.equal(ok.body.deleted, true);
  assert.equal((await jsonBody(await call(env, "/api/v1/leaderboard"))).body.total, 0);
});

test("CORS 预检与未知接口", async () => {
  const env = freshEnv();
  const opt = await call(env, "/api/v1/submit", { method: "OPTIONS" });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get("access-control-allow-origin"), "*");
  assert.equal((await jsonBody(await call(env, "/api/nope"))).status, 404);
});

test("assets.js 与源文件保持一致（防止页面/基准漂移）", async () => {
  const page = fs.readFileSync(new URL("../../leaderboard/public/index.html", import.meta.url), "utf8");
  assert.equal((await import("../src/assets.js")).pageHtml, page, "改完页面请跑 node worker/scripts/sync-assets.mjs");
  const baselinesFile = JSON.parse(fs.readFileSync(new URL("../../leaderboard/baselines.json", import.meta.url), "utf8"));
  assert.deepEqual((await import("../src/assets.js")).baselines, baselinesFile);
});

test("同型号筛选：D1 json_extract 精确匹配，且不筛选时仍是全榜", async () => {
  const env = freshEnv();
  await post(env, submission({ fp: "aaaa1111aaaa1111", cpuModel: "Intel Celeron J4125", mult: 1.1 }));
  await post(env, submission({ fp: "bbbb2222bbbb2222", cpuModel: "Intel Celeron J4125", mult: 1.0 }));
  await post(env, submission({ fp: "cccc3333cccc3333", cpuModel: "AMD Ryzen 7 5825U", mult: 2.0 }));

  const r = await jsonBody(await call(env, "/api/v1/leaderboard?dim=overall&limit=50&cpu=Intel%20Celeron%20J4125"));
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.entries.length, 2);
  assert.ok(r.body.entries.every((e) => e.hardware.cpu_model === "Intel Celeron J4125"));

  const all = await jsonBody(await call(env, "/api/v1/leaderboard?dim=overall&limit=50"));
  assert.equal(all.body.total, 3);

  const empty = await jsonBody(await call(env, "/api/v1/leaderboard?dim=overall&limit=50&cpu=Nonexistent"));
  assert.equal(empty.body.total, 0);
});

test("同型号排名：score 落在同型号池里，不受别的 CPU 干扰", async () => {
  const env = freshEnv();
  await post(env, submission({ fp: "aaaa1111aaaa1111", cpuModel: "Intel Celeron J4125", mult: 1.0 }));
  await post(env, submission({ fp: "cccc3333cccc3333", cpuModel: "AMD Ryzen 7 5825U", mult: 3.0 }));
  const r = await jsonBody(await call(env, "/api/v1/leaderboard?dim=overall&limit=50&cpu=Intel%20Celeron%20J4125&score=1000"));
  assert.equal(r.body.total, 1);
  assert.equal(r.body.me.rank, 1);
});
