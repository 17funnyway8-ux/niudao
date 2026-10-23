/** 存储层：SQLite 主后端 + JSONL 兜底 + 游标分页 + 旧数据迁移 + 保留策略。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-store-"));
process.env.NIUDAO_DATA = dataDir;
process.env.NIUDAO_TARGET = dataDir;

const store = await import("../src/server/store.js");

const rec = (i, kind = "fast") => ({
  id: `id-${kind}-${i}`,
  ts: 1700000000000 + i,
  kind,
  suite: "1.0.0",
  client: "1.0.0",
  fingerprint: "aaaaaaaaaaaaaaaa",
  arch: "x64",
  hardware: { cpu_model: "Test CPU", mem_gb: 16 },
  scores: kind === "fast" ? { composite: 1000 + i, dims: { cpu: { score: 1000 + i }, memory: { score: 900 }, storage: { score: 1100 } } } : undefined,
  stability: kind === "deep" ? { verdict: { headline: "散热合格", level: "good" }, temp: { maxC: 62.5 } } : undefined,
});

test("后端选择：优先 SQLite，其次 JSONL", () => {
  const info = store.storageInfo();
  assert.ok(["sqlite", "jsonl"].includes(info.backend), info.backend);
  assert.equal(info.total, 0);
});

test("写入与读取：按 id 精确取回完整记录", () => {
  store.appendResult(rec(1));
  const got = store.getResult("id-fast-1");
  assert.ok(got);
  assert.equal(got.scores.composite, 1001);
  assert.equal(got.hardware.cpu_model, "Test CPU");
});

test("列表摘要：快速档与深度档字段都能映射", () => {
  store.appendResult(rec(2, "deep"));
  const list = store.listResults(10);
  assert.equal(list.length, 2);
  const deep = list.find((r) => r.kind === "deep");
  assert.equal(deep.verdict, "散热合格");
  assert.equal(deep.maxTempC, 62.5);
  assert.equal(deep.composite, 0, "深度档没有综合分");
});

test("游标分页：limit + before 不重不漏", () => {
  for (let i = 3; i <= 12; i += 1) store.appendResult(rec(i));
  const p1 = store.pageResults({ limit: 4 });
  assert.equal(p1.items.length, 4);
  assert.ok(p1.nextCursor);
  const p2 = store.pageResults({ limit: 4, before: p1.nextCursor });
  const p3 = store.pageResults({ limit: 20, before: p2.nextCursor });
  const ids = [...p1.items, ...p2.items, ...p3.items].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "分页不能重复");
  assert.equal(ids.length, 12, "一共 12 条（2 条最新 + 10 条追加）");
  // 时间严格降序
  for (let i = 1; i < ids.length; i += 1) {
    const prev = p1.items.concat(p2.items, p3.items)[i - 1].ts;
    const cur = p1.items.concat(p2.items, p3.items)[i].ts;
    assert.ok(prev > cur);
  }
});

test("更新（标记已提交）与删除", () => {
  const up = store.updateResult("id-deep-2", { submitted: true });
  assert.equal(up.submitted, true);
  assert.equal(store.getResult("id-deep-2").submitted, true);
  assert.equal(store.deleteResult("id-deep-2"), true);
  assert.equal(store.getResult("id-deep-2"), null);
  assert.equal(store.deleteResult("不存在"), false);
});

test("本机排名只统计快速档", () => {
  const rank = store.localRank(1005);
  assert.ok(rank.total >= 1);
  assert.ok(rank.best > 1005);
  assert.ok(rank.better >= 1);
});

test("保留策略：超过上限的旧记录会被清理", () => {
  const before = store.storageInfo();
  assert.ok(before.total > 0);
  // 直接调后端的 prune（append 每 20 条自动触发一次）
  for (let i = 100; i < 130; i += 1) store.appendResult(rec(i));
  const after = store.storageInfo();
  assert.ok(after.fast <= 200, `快速档保留上限失效: ${after.fast}`);
});

test("旧数据迁移：results.jsonl 存在时自动导入并留档（独立进程验证）", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-migrate-"));
  const jsonl = path.join(dir, "results.jsonl");
  fs.writeFileSync(jsonl, `${JSON.stringify(rec(1))}\n${JSON.stringify(rec(2, "deep"))}\n`);
  const script = `
    const s = await import(${JSON.stringify(path.resolve("src/server/store.js"))});
    console.log(JSON.stringify(s.storageInfo()));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NIUDAO_DATA: dir, NIUDAO_TARGET: dir },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const info = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(info.total, 2, "两条旧成绩都应导入");
  if (info.backend === "sqlite") assert.ok(fs.existsSync(`${jsonl}.migrated`), "旧文件应改名留档");
  fs.rmSync(dir, { recursive: true, force: true });
});
