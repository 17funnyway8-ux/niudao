import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  DIMENSIONS,
  METRIC_KEYS,
  SUB_CAP,
  computeScores,
  formatMetric,
  gradeOf,
  normalizeMetric,
  percentileOf,
} from "../src/shared/scoring.js";

const baselines = {
  cpu_single: 1000,
  cpu_multi: 8000,
  crypto_aes: 1000,
  zlib: 100,
  mem_copy: 10,
  mem_latency: 100,
  disk_seq_read: 500,
  disk_seq_write: 400,
  disk_rand_read: 8000,
  disk_rand_write: 10000,
};

const perfect = { ...baselines };

test("权重：每个维度内部权重和为 1，跨维度权重和为 1", () => {
  let sum = 0;
  for (const dim of Object.values(DIMENSIONS)) {
    const inner = Object.values(dim.parts).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(inner - 1) < 1e-9, `维度权重和应为 1，实际 ${inner}`);
    sum += dim.weight;
  }
  assert.ok(Math.abs(sum - 1) < 1e-9, `维度权重总和应为 1，实际 ${sum}`);
});

test("每个被计分的指标都真实存在于指标表里", () => {
  for (const dim of Object.values(DIMENSIONS)) {
    for (const key of Object.keys(dim.parts)) {
      assert.ok(METRIC_KEYS.includes(key), `${key} 不在 METRICS 里`);
    }
  }
  assert.deepEqual([...METRIC_KEYS].sort(), Object.keys(baselines).sort(), "指标表与基准表要一一对应");
});

test("基准机跑出基准值 → 每项 1000、综合 1000", () => {
  const s = computeScores(perfect, baselines);
  for (const key of METRIC_KEYS) assert.equal(s.subs[key], 1000, key);
  for (const dim of Object.keys(DIMENSIONS)) assert.equal(s.dims[dim].score, 1000, dim);
  assert.equal(s.composite, 1000);
  assert.equal(s.partial, false);
});

test("两倍性能 → 两倍分数；延迟类指标反向", () => {
  const twice = Object.fromEntries(METRIC_KEYS.map((k) => [k, k === "mem_latency" ? baselines[k] / 2 : baselines[k] * 2]));
  const s = computeScores(twice, baselines);
  assert.equal(s.composite, 2000);
  assert.equal(normalizeMetric("mem_latency", 50, baselines), 2000);
});

test("缺失指标时按已有项重新归一，并标记 partial", () => {
  const partial = { ...perfect };
  delete partial.disk_rand_read;
  delete partial.disk_rand_write;
  const s = computeScores(partial, baselines);
  assert.equal(s.partial, true);
  assert.equal(s.dims.storage.score, 1000, "存储只剩顺序项，仍是 1000");
  assert.equal(s.dims.storage.coverage, 0.35);
  assert.equal(s.composite, 1000);
});

test("某个维度全缺时不参与综合分计算", () => {
  const onlyCpu = { cpu_single: 1000, cpu_multi: 8000, crypto_aes: 1000, zlib: 100 };
  const s = computeScores(onlyCpu, baselines);
  assert.equal(s.dims.storage.score, null);
  assert.equal(s.dims.cpu.score, 1000);
  assert.equal(s.composite, 1000, "只有 CPU 时综合分等于 CPU 分，而不是被 0 拉低");
});

test("异常输入不会算出 Infinity/NaN", () => {
  const bad = computeScores({ cpu_single: 0, cpu_multi: -5, mem_latency: 0 }, baselines);
  assert.ok(Number.isFinite(bad.composite));
  assert.equal(bad.dims.cpu.score, null);
});

test("等级阈值连续且覆盖 0 分", () => {
  assert.equal(gradeOf(2000).grade, "S");
  assert.equal(gradeOf(1400).grade, "S");
  assert.equal(gradeOf(1399).grade, "A");
  assert.equal(gradeOf(1000).grade, "B");
  assert.equal(gradeOf(700).grade, "C");
  assert.equal(gradeOf(0).grade, "D");
});

test("百分位：中位数约 50，最高接近 100，最低 0", () => {
  const asc = [100, 200, 300, 400, 500];
  assert.equal(percentileOf(300, asc), 50);
  assert.equal(percentileOf(500, asc), 90, "5 台里最高的一台超过 90%（中点法）");
  assert.equal(percentileOf(600, asc), 100);
  assert.equal(percentileOf(50, asc), 0);
  assert.equal(percentileOf(350, asc), 60);
  assert.equal(percentileOf(300, []), null);
});

test("指标展示格式不会出现 NaN", () => {
  assert.match(formatMetric("cpu_single", 1821.44), /1,821/);
  assert.equal(formatMetric("cpu_single", undefined), "—");
});

test("单项封顶：失真指标不能把总分拉爆（麒麟猪那次事故的回归测试）", () => {
  const base = JSON.parse(fs.readFileSync(new URL("../src/server/data/baselines.json", import.meta.url), "utf8")).metrics;
  // 真实数据：Mac mini M4 上的 fnOS 虚机，磁盘读报到 32 GB/s（写在内存里被吞了）
  const metrics = {
    cpu_single: 3616,
    cpu_multi: 12745.6,
    crypto_aes: 5743.8,
    zlib: 72.5,
    mem_copy: 59.87,
    mem_latency: 41,
    disk_seq_read: 32094.4,
    disk_seq_write: 7976.3,
    disk_rand_read: 159990,
    disk_rand_write: 29950,
  };
  const s = computeScores(metrics, base);
  assert.ok(s.composite < 3000, `综合分必须被封顶压住，实际 ${s.composite}`);
  assert.ok(s.subs.disk_seq_read <= SUB_CAP, "单项不超过封顶值");
  assert.ok(s.capped.includes("disk_seq_read"), "要标出哪些项触顶了");
  assert.equal(s.partial, true, "有触顶项时报告要标「部分项异常」");
});
