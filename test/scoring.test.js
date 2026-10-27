import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  DIMENSIONS,
  METRIC_KEYS,
  SCORED_KEYS,
  PHYSICAL_MAX,
  capOf,
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
  // audit 项：不参与评分，但基准表里要有（用于校验提交数据的合理性）
  // 这些值必须是"真实磁盘"的量级，否则审核判据会把正常成绩误判成缓存
  disk_rand_read_lat_us: 150,
  disk_rand_write_lat_us: 120,
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
  // audit 项必须真的不参与任何维度的权重
  for (const dim of Object.values(DIMENSIONS)) {
    for (const key of Object.keys(dim.parts)) {
      assert.ok(SCORED_KEYS.includes(key), `${key} 是 audit 项，不能进评分权重`);
    }
  }
});

test("基准机跑出基准值 → 每项 1000、综合 1000", () => {
  const s = computeScores(perfect, baselines);
  // 只断言参与评分的指标；audit 项（4K 延迟）不进 subs
  for (const key of SCORED_KEYS) assert.equal(s.subs[key], 1000, key);
  for (const key of METRIC_KEYS) if (!SCORED_KEYS.includes(key)) assert.equal(s.subs[key], undefined, `${key} 是 audit 项，不该出现在 subs`);
  for (const dim of Object.keys(DIMENSIONS)) assert.equal(s.dims[dim].score, 1000, dim);
  assert.equal(s.composite, 1000);
  assert.equal(s.partial, false);
});

test("两倍性能 → 两倍分数；延迟类指标反向", () => {
  const twice = Object.fromEntries(SCORED_KEYS.map((k) => [k, k === "mem_latency" ? baselines[k] / 2 : baselines[k] * 2]));
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

test("CPU 多核不封顶：机器强就是强，不能像以前那样一刀切到 3000", () => {
  const base = JSON.parse(fs.readFileSync(new URL("../src/server/data/baselines.json", import.meta.url), "utf8")).metrics;
  // Core Ultra 7 155H：22 线程，多核 3.24 倍基准机 —— 完全正常的真实结果
  const s = computeScores(
    { ...base, cpu_single: 3702.2, cpu_multi: 47161.1, crypto_aes: 2515.6, zlib: 64.5, mem_copy: 38.18, mem_latency: 65 },
    base,
  );
  assert.equal(capOf("cpu_multi", base), null, "CPU 多核不该有分数上限");
  assert.equal(capOf("cpu_single", base), null);
  assert.equal(capOf("crypto_aes", base), null);
  assert.ok(s.subs.cpu_multi > 3000, `多核应保留真实倍率（3240），实际 ${s.subs.cpu_multi}`);
  assert.ok(!s.capped.includes("cpu_multi"));
});

test("磁盘封顶按物理上限换算，且不误伤真实 NVMe", () => {
  const base = JSON.parse(fs.readFileSync(new URL("../src/server/data/baselines.json", import.meta.url), "utf8")).metrics;
  // 真实 PCIe 4.0 NVMe 池：读 7 GB/s、写 6 GB/s、4K 28k/24k —— 必须一分不封
  const realNvme = { ...base, disk_seq_read: 7000, disk_seq_write: 6000, disk_rand_read: 28000, disk_rand_write: 24000 };
  const ok = computeScores(realNvme, base);
  assert.deepEqual(ok.capped, [], `真实 NVMe 不该被任何项封顶，实际封了 ${ok.capped.join(",")}`);

  // 虚机页缓存：顺序读 15 GB/s（超过 PCIe4 单盘上限）
  const vm = { ...base, disk_seq_read: 15322.8, disk_rand_read: 87469 };
  const capped = computeScores(vm, base);
  assert.ok(capped.capped.includes("disk_seq_read"), "15 GB/s 顺序读超过物理上限，应被封");
  assert.ok(capped.capped.includes("disk_rand_read"), "87k IOPS @QD1 超过物理上限，应被封");
  assert.equal(capped.partial, true, "有触顶项时报告要标注");
});

test("封顶值是物理上限换算来的，不是拍脑袋的固定分数", () => {
  const base = JSON.parse(fs.readFileSync(new URL("../src/server/data/baselines.json", import.meta.url), "utf8")).metrics;
  for (const [key, spec] of Object.entries(PHYSICAL_MAX)) {
    const cap = capOf(key, base);
    assert.ok(Number.isFinite(cap) && cap > 0, `${key} 的分数上限算不出来`);
    // 反算：上限分数对应的原始值应该等于 PHYSICAL_MAX
    const rawAtCap = spec.min ? base[key] / (cap / 1000) : (cap / 1000) * base[key];
    const expect = spec.min ?? spec;
    assert.ok(Math.abs(rawAtCap - expect) / expect < 0.01, `${key}: 上限对应原值 ${rawAtCap.toFixed(1)} ≠ 物理上限 ${expect}`);
  }
});
