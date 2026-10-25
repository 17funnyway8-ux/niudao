/**
 * 大小核调度相关：拓扑解析 + 钉核。
 *
 * 用户反馈："测单核时跑到 E 核上"（Intel Core Ultra 7 155H，6P+8E+2LPE）。
 * 这类 CPU 上单线程任务如果落到 E 核，分数会腰斩，而报告里看不出任何线索。
 * 这里锁住三件事：CPULIST 解析、P 核挑选规则、以及本机不是混合架构时不许乱钉。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTopology, detectHybrid, parseCpuList, pickPCore } from "../src/server/bench/affinity.js";

test("CPULIST 解析：支持区间与逗号混写（sysfs 的格式）", () => {
  assert.deepEqual(parseCpuList("0-3"), [0, 1, 2, 3]);
  assert.deepEqual(parseCpuList("0,2,4-6"), [0, 2, 4, 5, 6]);
  assert.deepEqual(parseCpuList(""), []);
  assert.deepEqual(parseCpuList("abc"), []);
});

test("P 核挑选：避开 cpu0（中断都压在它上面），取最后一个 P 核", () => {
  const hybrid = { hybrid: true, pCores: [0, 1, 2, 3, 4, 5], eCores: [6, 7, 8, 9] };
  assert.equal(pickPCore(hybrid), 5, "应挑 5（最后一个 P 核），不是 0");
  assert.equal(pickPCore({ hybrid: true, pCores: [0], eCores: [1] }), 0, "只有一个 P 核时只能用 0");
  assert.equal(pickPCore({ hybrid: false, pCores: [], eCores: [] }), null, "非混合架构不该钉核");
});

test("本机拓扑检测自洽（AMD/非混合架构必须报告 hybrid=false）", () => {
  const t = detectHybrid();
  assert.equal(typeof t.hybrid, "boolean");
  if (t.hybrid) {
    assert.ok(t.pCores.length > 0 && t.eCores.length > 0);
    assert.ok(t.pCores.length + t.eCores.length > 0);
    assert.ok(describeTopology(t).label.includes("性能核"));
  } else {
    assert.deepEqual(t.pCores, []);
    assert.equal(pickPCore(t), null, "非混合架构钉核会是 null → 走原来的 worker 路径");
  }
});

test("混合架构的描述要能直接给人看", () => {
  const d = describeTopology({ hybrid: true, pCores: [0, 1, 2, 3, 4, 5], eCores: [6, 7, 8, 9, 10, 11, 12, 13], source: "cpu_core/cpu_atom" });
  assert.match(d.label, /6 个性能核 \+ 8 个能效核/);
  assert.deepEqual(describeTopology({ hybrid: false }), { hybrid: false });
});
