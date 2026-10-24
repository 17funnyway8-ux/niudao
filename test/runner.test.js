/**
 * 编排层回归测试：跑完整一轮（参数压到最小），检查每一项都被真正测到。
 *
 * 为什么需要：把 diskSeq / diskRandom 从同步改成异步时，`step(4, () => {...})`
 * 这种「箭头函数块体不 return promise」的写法会让 await 立刻返回 ——
 * 结果磁盘项被静默跳过，metrics 里就是空的，而单测全绿。这个用例专门守这条缝：
 * 不但要检查指标有值，还要检查**耗时**够长（说明真的打了盘，不是空转）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { runSuite } = await import("../src/server/runner.js");

test("完整一轮：六项指标都有值，磁盘阶段确实跑过（不是空转）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-runner-"));
  try {
    const run = await runSuite({
      targetDir: dir,
      opts: { cpuSingleMs: 200, cpuMultiMs: 200, diskSizeMb: 64, diskFileMb: 64, diskSeconds: 1 },
    });

    assert.deepEqual(run.errors, [], "不该有失败的阶段");

    for (const key of ["cpu_single", "cpu_multi", "crypto_aes", "zlib", "mem_copy", "mem_latency", "disk_seq_read", "disk_seq_write"]) {
      assert.ok(run.metrics[key] > 0, `${key} 应该有正数，实际 ${run.metrics[key]}`);
    }

    // CPU 单核两轮 + 预热，至少 400ms；磁盘顺序要真写 64MB，不可能 100ms 内完成
    assert.ok(run.durations.cpu_single > 350, `cpu_single 耗时异常: ${run.durations.cpu_single}ms`);
    assert.ok(run.durations.disk_seq > 50, `disk_seq 被跳过了？只用了 ${run.durations.disk_seq}ms`);
    assert.ok(run.durations.disk_random > 50, `disk_random 被跳过了？只用了 ${run.durations.disk_random}ms`);

    assert.equal(
      fs.readdirSync(dir).filter((f) => f.startsWith(".niudao")).length,
      0,
      "临时文件应该被清理",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("中途取消：返回 cancelled，且不留下半截文件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-runner-cancel-"));
  try {
    let stopping = false;
    const run = await runSuite({
      targetDir: dir,
      opts: { cpuSingleMs: 150, cpuMultiMs: 150, diskSizeMb: 64, diskFileMb: 64, diskSeconds: 1, shouldStop: () => stopping },
      onEvent: (ev) => {
        if (ev.type === "stage" && ev.status === "done" && ev.stage === "cpu_multi") stopping = true;
      },
    });
    assert.equal(run.cancelled, true);
    assert.ok(run.durations.cpu_single > 0);
    assert.equal(
      fs.readdirSync(dir).filter((f) => f.startsWith(".niudao")).length,
      0,
      "取消后也要清理临时文件",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
