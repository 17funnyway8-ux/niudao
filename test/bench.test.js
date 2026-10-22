/** 基准实现的自检：短时限跑一遍，确认内核真的在算、单位量级合理、异常路径有兜底。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OPS_PER_ITER, kernelWork } from "../src/server/bench/kernel.js";
import { cpuMulti, cpuSingle, scalingEfficiency } from "../src/server/bench/cpu.js";
import { memBandwidth, memLatency } from "../src/server/bench/memory.js";
import { aesThroughput, zlibThroughput } from "../src/server/bench/crypto.js";
import { diskRandom, diskSeq } from "../src/server/bench/disk.js";

test("CPU 内核：固定时限内完成迭代，吞吐为正且随负载变化", () => {
  const a = kernelWork(120);
  const b = kernelWork(240);
  assert.ok(a.iters > 0);
  assert.ok(b.iters > a.iters, "跑得久迭代就多");
  assert.ok(a.mops > 1 && a.mops < 100000, `单核吞吐量级异常: ${a.mops}`);
  assert.equal(typeof a.sink, "number");
  assert.equal(OPS_PER_ITER, 16);
});

test("单核测试两轮取优，多核吞吐高于单核", async () => {
  const single = cpuSingle(180);
  assert.ok(single.mops > 0);
  const multi = await cpuMulti(220);
  assert.ok(multi.mops > single.mops, `多核 ${multi.mops} 应高于单核 ${single.mops}`);
  const eff = scalingEfficiency(single.mops, multi.mops, multi.detail.threads);
  assert.ok(eff > 10 && eff <= 100, `扩展效率应在 (10,100]，实际 ${eff}`);
});

test("内存：带宽为正、延迟在物理合理区间", () => {
  const bw = memBandwidth(24, 2);
  assert.ok(bw.gbs > 0.5, `带宽异常: ${bw.gbs}`);
  const lat = memLatency(4, 200_000);
  assert.ok(lat.ns >= 5 && lat.ns <= 5000, `延迟异常: ${lat.ns}ns`);
});

test("加密与压缩：吞吐量级合理、压缩率接近真实备份", () => {
  const aes = aesThroughput(32, 16);
  assert.ok(aes.mbs > 10, `AES 吞吐异常: ${aes.mbs}`);
  const z = zlibThroughput(4);
  assert.ok(z.mbs > 1, `zlib 吞吐异常: ${z.mbs}`);
  assert.ok(z.detail.ratio > 0.1 && z.detail.ratio <= 1, `压缩率异常: ${z.detail.ratio}`);
});

test("磁盘顺序：真实读写一个 64MB 文件，速率合理并清理临时文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-disk-"));
  try {
    const r = diskSeq(dir, { sizeMb: 64 });
    assert.ok(r.read_mbs > 1, `顺序读异常: ${r.read_mbs}`);
    assert.ok(r.write_mbs > 1, `顺序写异常: ${r.write_mbs}`);
    const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith(".niudao"));
    assert.deepEqual(leftovers, [], "测试文件应被清理");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("磁盘 4K 随机：能跑出 IOPS；没有 python 时优雅降级为 null + 说明", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-rand-"));
  try {
    const r = diskRandom(dir, { fileMb: 64, seconds: 1 });
    if (r.read_iops === null) {
      assert.ok(r.caveats.length > 0, "跳过时必须给出原因");
    } else {
      assert.ok(r.read_iops > 10, `随机读 IOPS 异常: ${r.read_iops}`);
      assert.ok(r.write_iops === null || r.write_iops > 10);
    }
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".niudao")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
