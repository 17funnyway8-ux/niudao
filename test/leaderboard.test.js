import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../leaderboard/store.js";
import { computeScores, gradeOf } from "../src/shared/scoring.js";

const baselines = JSON.parse(
  fs.readFileSync(new URL("../src/server/data/baselines.json", import.meta.url), "utf8"),
).metrics;

const tmpStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-lb-"));
  return new Store(path.join(dir, "submissions.jsonl"));
};

let seq = 0;
const entry = ({ fp = "aaaa1111bbbb2222", arch = "x64", metrics, alias = "", suite = "1.0.0" } = {}) => {
  const m = metrics || { ...baselines };
  const scores = computeScores(m, baselines);
  seq += 1;
  return {
    id: `id-${seq}`,
    ts: 1700000000000 + seq,
    suite,
    fingerprint: fp,
    arch,
    alias,
    hardware: { cpu_model: "Test CPU", mem_gb: 16, threads: 8 },
    metrics: m,
    scores,
    grade: gradeOf(scores.composite),
  };
};

test("同一台机器只保留最好成绩上榜，但原始提交都留档", () => {
  const s = tmpStore();
  s.add(entry());
  s.add(entry({ metrics: { ...baselines, cpu_single: baselines.cpu_single * 0.5 } })); // 更差
  s.add(entry({ metrics: { ...baselines, cpu_single: baselines.cpu_single * 1.5 } })); // 更好
  assert.equal(s.all.length, 3, "三条提交都留档");
  assert.equal(s.ranked("1.0.0", "").length, 1, "榜上只有一台机器");
  const board = s.leaderboard({ dim: "overall" });
  assert.ok(board.entries[0].composite > 1000, "取的是最好那条");
});

test("按维度排序 + 排名 + 百分位 + 前后邻位", () => {
  const s = tmpStore();
  const mk = (fp, mult) => entry({ fp, metrics: Object.fromEntries(Object.entries(baselines).map(([k, v]) => [k, k === "mem_latency" ? v / mult : v * mult])) });
  s.add(mk("0000000000000001", 0.5));
  s.add(mk("0000000000000002", 1.0));
  s.add(mk("0000000000000003", 1.5));
  s.add(mk("0000000000000004", 2.0));
  const board = s.leaderboard({ dim: "overall", score: 1000 });
  assert.equal(board.total, 4);
  assert.deepEqual(board.entries.map((e) => e.rank), [1, 2, 3, 4]);
  assert.ok(board.entries[0].value > board.entries[3].value, "降序");
  assert.equal(board.me.rank, 3, "2000/1500 在它前面，另有 1 台与它并列 → 名次 3");
  assert.equal(board.me.percentile, 37.5);
  assert.equal(board.me.above.value, 1500, "前一名就是紧挨着它的那台");
  assert.equal(board.me.below.value, 500);
});

test("架构分开排：ARM 不与 x86 混", () => {
  const s = tmpStore();
  s.add(entry({ fp: "1111111111111111", arch: "x64" }));
  s.add(entry({ fp: "2222222222222222", arch: "arm64", metrics: { ...baselines, cpu_multi: baselines.cpu_multi * 0.4 } }));
  assert.equal(s.leaderboard({ arch: "x64" }).total, 1);
  assert.equal(s.leaderboard({ arch: "arm64" }).total, 1);
  assert.equal(s.leaderboard({ arch: "arm64" }).entries[0].arch, "arm64");
});

test("套件版本隔离：旧版本成绩不进新榜", () => {
  const s = tmpStore();
  s.add(entry({ fp: "3333333333333333", suite: "0.9.0" }));
  s.add(entry({ fp: "4444444444444444", suite: "1.0.0" }));
  assert.equal(s.leaderboard({ suite: "1.0.0" }).total, 1);
  assert.equal(s.leaderboard({ suite: "0.9.0" }).total, 1);
});

test("删除条目后索引重建，榜上数据一致", () => {
  const s = tmpStore();
  const a = entry({ fp: "5555555555555555" });
  s.add(a);
  s.add(entry({ fp: "6666666666666666" }));
  assert.equal(s.leaderboard({}).total, 2);
  assert.equal(s.remove(a.id), true);
  assert.equal(s.leaderboard({}).total, 1);
  assert.equal(s.remove("不存在"), false);
});

test("持久化：重新加载后榜上数据不丢", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-lb-"));
  const file = path.join(dir, "submissions.jsonl");
  const s1 = new Store(file);
  s1.add(entry({ fp: "7777777777777777" }));
  const s2 = new Store(file);
  assert.equal(s2.leaderboard({}).total, 1);
  assert.equal(s2.all.length, 1);
});

test("分布直方图按 100 分分桶", () => {
  const s = tmpStore();
  s.add(entry({ fp: "8888888888888888" }));
  const board = s.leaderboard({});
  const keys = Object.keys(board.buckets);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "1000");
  assert.equal(board.buckets["1000"], 1);
});
