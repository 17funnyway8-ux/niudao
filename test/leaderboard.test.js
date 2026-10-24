import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MIN_SAMPLES, Store, medianCI, nameKey } from "../leaderboard/store.js";
import { computeScores, gradeOf } from "../src/shared/scoring.js";

const baselines = JSON.parse(
  fs.readFileSync(new URL("../src/server/data/baselines.json", import.meta.url), "utf8"),
).metrics;

const tmpStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-lb-"));
  return new Store(path.join(dir, "submissions.jsonl"));
};

let seq = 0;
const entry = ({ fp = "aaaa1111bbbb2222", arch = "x64", metrics, alias = "", suite = "1.0.0", hardware, compositeMult, mult } = {}) => {
  const m = metrics || { ...baselines };
  const scale = compositeMult ?? mult;
  if (scale) {
    for (const k of Object.keys(m)) m[k] = k === "mem_latency" ? m[k] / scale : m[k] * scale;
  }
  const scores = computeScores(m, baselines);
  seq += 1;
  return {
    id: `id-${seq}`,
    ts: 1700000000000 + seq,
    suite,
    fingerprint: fp,
    arch,
    alias,
    hardware: { cpu_model: "Test CPU", mem_gb: 16, threads: 8, ...(hardware || {}) },
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
  assert.equal(board.me.percentile, null, "样本不足 30 台，不给百分位（对齐 Speedtest 的样本门槛）");
  assert.equal(board.stats.gated, true);
  assert.equal(board.stats.needed, MIN_SAMPLES - 4);
  assert.equal(board.me.above.value, 1500, "前一名就是紧挨着它的那台");
  assert.equal(board.me.below.value, 500);
});

test("样本达到门槛后才给百分位，并给出中位数与置信区间", () => {
  const s = tmpStore();
  for (let i = 0; i < MIN_SAMPLES; i += 1) {
    const mult = 0.5 + (i / MIN_SAMPLES) * 1.5;
    s.add(entry({ fp: String(i).padStart(16, "0"), metrics: Object.fromEntries(Object.entries(baselines).map(([k, v]) => [k, k === "mem_latency" ? v / mult : v * mult])) }));
  }
  const board = s.leaderboard({ dim: "overall", score: 1000 });
  assert.equal(board.total, MIN_SAMPLES);
  assert.equal(board.stats.gated, false);
  assert.ok(board.me.percentile > 0 && board.me.percentile < 100, `百分位异常: ${board.me.percentile}`);
  assert.ok(board.stats.median > 0);
  assert.equal(board.stats.ci.length, 2);
  assert.ok(board.stats.ci[0] <= board.stats.median && board.stats.median <= board.stats.ci[1]);
});

test("中位数置信区间：顺序统计量法，不假设分布", () => {
  const asc = Array.from({ length: 40 }, (_, i) => i + 1);
  const { median, ci } = medianCI(asc);
  assert.equal(median, 20.5);
  assert.ok(ci[0] < median && median < ci[1]);
  // 样本太少时不给区间
  assert.equal(medianCI([1, 2, 3]).ci, null);
  assert.equal(medianCI([]).median, null);
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

test("同型号过滤：只看同一颗 CPU，跨型号不混榜", () => {
  const s = tmpStore();
  s.add(entry({ fp: "aaaa111111111111", compositeMult: 1.1, hardware: { cpu_model: "Intel Celeron J4125" } }));
  s.add(entry({ fp: "bbbb222222222222", compositeMult: 1.0, hardware: { cpu_model: "Intel Celeron J4125" } }));
  s.add(entry({ fp: "cccc333333333333", compositeMult: 2.0, hardware: { cpu_model: "AMD Ryzen 7 5825U" } }));

  const j = s.leaderboard({ cpu: "Intel Celeron J4125" });
  assert.equal(j.total, 2);
  assert.equal(j.entries.length, 2);
  assert.ok(j.entries.every((e) => e.hardware.cpu_model === "Intel Celeron J4125"));
  assert.equal(j.entries[0].hardware.cpu_model, "Intel Celeron J4125");
  assert.equal(s.leaderboard({}).total, 3, "不筛选时还是全部");

  assert.equal(s.leaderboard({ cpu: "不存在的型号" }).total, 0);
});

test("同型号过滤与排名计算兼容：me 只在同型号池里排", () => {
  const s = tmpStore();
  s.add(entry({ fp: "aaaa111111111111", compositeMult: 1.0, hardware: { cpu_model: "Intel Celeron J4125" } }));
  s.add(entry({ fp: "cccc333333333333", compositeMult: 3.0, hardware: { cpu_model: "AMD Ryzen 7 5825U" } }));
  const board = s.leaderboard({ cpu: "Intel Celeron J4125", score: 1000 });
  assert.equal(board.total, 1);
  assert.equal(board.me.rank, 1, "强 CPU 不该影响同型号的排名");
});

test("重名不影响成绩隔离：同名两台机器各有各的条目，能认出哪条是我", () => {
  const s = tmpStore();
  const a = entry({ fp: "aaaa111122223333", alias: "老王", mult: 1.2 });
  const b = entry({ fp: "bbbb444455556666", alias: "老王", mult: 1.0 });
  s.add(a);
  s.add(b);

  const board = s.leaderboard({ fingerprint: a.fingerprint });
  assert.equal(board.total, 2, "重名不能合并，两台机器都在榜上");
  const mine = board.entries.filter((e) => e.isMine);
  assert.equal(mine.length, 1, "只能认出一行是我");
  assert.equal(mine[0].id, a.id, "认出来的是我这台机器的那条");
  // dup 的语义：花名相同、但机器不同 —— 足够提醒用户"这不是我"
  assert.equal(board.entries.length, 2);
  assert.equal(board.entries.filter((e) => e.dup).length, 2, "同名两台机器都应标记重名");
  assert.ok(board.entries.some((e) => e.isMine), "至少有一行认得出是我");
  assert.notEqual(nameKey(a), nameKey(b), "名字相同但 nameKey 必须不同");
});

test("不传身份时不会把别人的行误判成我的", () => {
  const s = tmpStore();
  s.add(entry({ fp: "aaaa111122223333", alias: "老王" }));
  s.add(entry({ fp: "bbbb444455556666", alias: "老王" }));
  const board = s.leaderboard({});
  assert.equal(board.entries.filter((e) => e.isMine).length, 0);
});
