/** 应用 HTTP 接口测试：不起完整套件（那要 40 秒），只验路由、校验与本地榜单降级。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-http-"));
process.env.NIUDAO_DATA = dataDir;
process.env.NIUDAO_TARGET = dataDir;
process.env.NIUDAO_EDGE = "off"; // 单测不联网、不探测 CF 边缘

const { start } = await import("../src/server/http.js");
const { appendResult } = await import("../src/server/store.js");
const { computeScores, gradeOf } = await import("../src/shared/scoring.js");

const baselines = JSON.parse(fs.readFileSync(new URL("../src/server/data/baselines.json", import.meta.url), "utf8")).metrics;
const { server, port } = await start({ port: 0 });
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = async (p, body) => {
  const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const fakeResult = (compositeMult = 1) => {
  const metrics = Object.fromEntries(Object.entries(baselines).map(([k, v]) => [k, k === "mem_latency" ? v / compositeMult : v * compositeMult]));
  const scores = computeScores(metrics, baselines);
  return {
    id: `r-${compositeMult}`,
    ts: Date.now(),
    suite: "1.0.0",
    client: "1.0.0",
    fingerprint: "ffff0000ffff0000",
    arch: "x64",
    hardware: { cpu_model: "Fake CPU", cores: 4, threads: 8, mem_gb: 16, os_version: "1.2.0401", kernel: "6.1", volume: dataDir, disks: [] },
    metrics,
    scores,
    grade: gradeOf(scores.composite),
    details: {},
    caveats: [],
    errors: [],
  };
};

test("健康检查返回套件版本", async () => {
  const r = await get("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.suite, /^\d+\.\d+\.\d+$/);
});

test("bootstrap 带回硬件、维度、指标定义", async () => {
  const r = await get("/api/bootstrap");
  assert.equal(r.status, 200);
  assert.ok(r.body.hardware.hardware.cpu_model);
  assert.ok(Object.keys(r.body.dimensions).includes("storage"));
  assert.ok(Object.keys(r.body.metrics).includes("disk_rand_read"));
  // 打包后默认指向内置官方榜
  assert.equal(r.body.leaderboard.configured, true);
  assert.equal(r.body.leaderboard.official, true);
  assert.match(r.body.leaderboard.officialUrl, /^https:\/\//);
});

test("首页静态文件可访问（单页回落）", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /牛刀/);
  const deep = await fetch(`${base}/whatever/path`);
  assert.equal(deep.status, 200, "未知路径回落到单页");
});

test("未配置排行榜时，天梯接口降级为本地成绩", async () => {
  await post("/api/settings", { leaderboardUrl: "" }); // 清空 = 只用本地成绩
  appendResult(fakeResult(1));
  appendResult(fakeResult(1.2));
  const r = await get("/api/leaderboard?dim=overall");
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "local");
  assert.equal(r.body.entries.length, 2);
  assert.ok(r.body.entries[0].value >= r.body.entries[1].value);
});

test("设置校验：非法地址被拒，合法地址被保存", async () => {
  const bad = await post("/api/settings", { leaderboardUrl: "ftp://x" });
  assert.equal(bad.status, 400);
  const ok = await post("/api/settings", { leaderboardUrl: "http://127.0.0.1:9", alias: "老王" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.alias, "老王");
  const after = await get("/api/settings");
  assert.equal(after.body.leaderboardUrl, "http://127.0.0.1:9");
});

test("测试目录校验：不存在/非绝对路径/特殊文件系统都立即返回 400（不允许卡死事件循环）", async () => {
  // /proc/nope 这类路径上 Node 的 recursive mkdir 会陷入死循环，这里确保我们不再这么干
  const started = Date.now();
  const r1 = await post("/api/settings", { targetDir: "/proc/nope" });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /不存在|不可写/);
  const r2 = await post("/api/settings", { targetDir: "relative/path" });
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /绝对路径/);
  const r3 = await post("/api/settings", { targetDir: "/etc/hostname" });
  assert.equal(r3.status, 400);
  assert.match(r3.body.error, /不是目录/);
  assert.ok(Date.now() - started < 3000, "校验必须立刻返回");
  // 正常的可写目录仍然通过
  const ok = await post("/api/settings", { targetDir: dataDir });
  assert.equal(ok.status, 200);
});

test("找不到的成绩单返回 404，存在的能读能删", async () => {
  const missing = await get("/api/results/not-there");
  assert.equal(missing.status, 404);
  const one = await get("/api/results/r-1.2");
  assert.equal(one.status, 200);
  assert.equal(one.body.hardware.cpu_model, "Fake CPU");
  const md = await fetch(`${base}/api/results/r-1.2/report.md`);
  assert.equal(md.status, 200);
  assert.match(await md.text(), /牛刀 · 性能报告/);
  const del = await fetch(`${base}/api/results/r-1.2`, { method: "DELETE" });
  assert.equal((await del.json()).deleted, true);
  assert.equal((await get("/api/results/r-1.2")).status, 404);
});

test("未知接口返回 404 JSON", async () => {
  const r = await get("/api/nope");
  assert.equal(r.status, 404);
  assert.ok(r.body.error);
});

test("空闲时状态是 idle，中止请求不会报错", async () => {
  const state = await get("/api/run");
  assert.equal(state.status, 200);
  assert.equal(state.body.status, "idle");
  const cancel = await post("/api/run/cancel", {});
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.cancelling, true);
});

test("统一网关前缀：/app/niudao 下的页面、静态资源与接口都要能用", async () => {
  // 飞牛统一网关把外部路径原样转发进来，应用必须自己剥前缀；
  // 首页还要在运行时注入 <base>，否则 styles.css / api 会解析到 NAS 根上（整页白屏）
  const health = await get("/app/niudao/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const page = await fetch(`${base}/app/niudao/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<base href="\/app\/niudao\/"/, "走网关时 base 必须是 /app/niudao/");
  assert.ok(!html.includes('href="/styles.css"'), "静态资源不能用绝对路径");

  const css = await fetch(`${base}/app/niudao/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") || "", /text\/css/);

  const deep = await fetch(`${base}/app/niudao/some/deep/link`); // SPA 回落也要带 base
  assert.match(await deep.text(), /<base href="\/app\/niudao\/"/);
});

test("直连（无前缀）时 base 是 /，开发态不受影响", async () => {
  const page = await fetch(`${base}/`);
  assert.match(await page.text(), /<base href="\/"/);
  const health = await get("/api/health");
  assert.equal(health.status, 200);
});
