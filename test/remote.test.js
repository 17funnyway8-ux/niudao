/**
 * 榜单客户端策略测试：对冲补发、业务错误不重试、连接池复用。
 *
 * 为什么要测：国内到 CF 免费边缘的握手是随机丢包的，客户端策略直接决定
 * 「看榜要等 0.4 秒还是 13 秒」。策略退化（比如把对冲改回顺序重试）必须有测试拦一下。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-remote-"));
process.env.NIUDAO_DATA = dataDir;
process.env.NIUDAO_TARGET = dataDir;

const { saveSettings } = await import("../src/server/settings.js");
const remote = await import("../src/server/remote.js");

let hits = 0;
let hangFirst = 0; // 头 N 个 /api/v1/health 请求故意不回
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    if (req.url.startsWith("/api/v1/health")) {
      if (hangFirst > 0) {
        hangFirst -= 1;
        return; // 挂住不回：模拟踩到坏连接
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, service: "fake" }));
    }
    if (req.url.startsWith("/api/v1/leaderboard")) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "库炸了" }));
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  saveSettings({ leaderboardUrl: base });
});

after(() => {
  remote.shutdown();
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("一条连接挂住时，1.5 秒后对冲补发拿到结果", async () => {
  hits = 0;
  hangFirst = 1; // 第一条永远不回
  const started = Date.now();
  const info = await remote.health();
  const elapsed = Date.now() - started;
  assert.equal(info.ok, true);
  assert.equal(info.service, "fake");
  assert.equal(hits, 2, "应该正好发了 2 条：第 1 条挂住，HEDGE_DELAY 后补第 2 条");
  assert.ok(elapsed >= 1400 && elapsed < 2400, `耗时应该在 1.5s 附近，实际 ${elapsed}ms`);
});

test("复用连接时不再重握手，多次调用很快", async () => {
  hangFirst = 0;
  // 上一个用例挂住的那条连接可能还在服务端排队，先清干净再计数
  server.closeAllConnections?.();
  await new Promise((r) => setTimeout(r, 50));
  hits = 0;
  const started = Date.now();
  for (let i = 0; i < 3; i += 1) await remote.health();
  const elapsed = Date.now() - started;
  assert.equal(hits, 3);
  assert.ok(elapsed < 1500, `3 次复用连接应该在 1.5s 内，实际 ${elapsed}ms`);
});

test("4xx/5xx 是业务错误，直接抛且只发一条", async () => {
  hits = 0;
  await assert.rejects(() => remote.leaderboard({ dim: "overall" }), /库炸了/);
  assert.equal(hits, 1, "业务错误重试没意义，不能补发");
});

test("没配地址时明确抛 NO_LEADERBOARD", async () => {
  saveSettings({ leaderboardUrl: "" });
  await assert.rejects(() => remote.leaderboard({}), /NO_LEADERBOARD/);
  assert.equal(remote.isConfigured(), false);
  saveSettings({ leaderboardUrl: base });
});
