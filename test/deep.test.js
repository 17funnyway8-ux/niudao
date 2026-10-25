/** 深度档编排：用极短时长真跑一遍（含真烤机、真采样、真复测），并验证可中止。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeDuration } from "../src/server/deep.js";
import { runDeep } from "../src/server/deep.js";
import { sample, discover, resetCache } from "../src/server/bench/thermal.js";

test("时长归一化：夹在 1 分钟到 60 分钟之间", () => {
  assert.equal(normalizeDuration(5), 60);
  assert.equal(normalizeDuration(300), 300);
  assert.equal(normalizeDuration(99999), 3600);
  assert.equal(normalizeDuration("abc"), 600);
});

test("传感器：至少能采到一个样本，字段类型正确；读不到就是 null 不编造", () => {
  resetCache();
  const d = discover();
  assert.equal(typeof d.hasCpuTemp, "boolean");
  const s = sample(1.5);
  assert.equal(s.t, 1.5);
  for (const key of ["cpuC", "freqMhz"]) {
    assert.ok(s[key] === null || typeof s[key] === "number", `${key} 必须是 number|null`);
  }
});

test("完整深度档：短烤机 + 采样 + 前后复测，产出可判读的结论", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-deep-"));
  const events = [];
  try {
    const r = await runDeep({
      targetDir: dir,
      durationSec: 4,
      roundMs: 400, rounds: 2,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.cancelled, false);
    assert.ok(r.stability, "必须有稳定性结论");
    assert.ok(["good", "ok", "warn", "bad", "unknown"].includes(r.stability.verdict.level));
    assert.ok(Array.isArray(r.rounds), "应有逐轮吞吐序列");
    assert.ok(r.stability.perf, "应该拿到前后两次多核吞吐");
    // 只校验"是个正数"：这个用例跑的是**真实烤机**，在共享/负载波动的机器上
    // 保持率会剧烈跳动（实测见过 49.5%），写死区间会变成 flaky 测试 —— 
    // 漂移的测试最后一定会被忽略，反而掩盖真问题。数值合理性交给单测过的纯函数。
    assert.ok(r.stability.perf.keepPct > 0, `保持率应为正数，实际: ${r.stability.perf.keepPct}`);
    assert.ok(r.series.length > 0, "应该有曲线数据");
    assert.ok(r.series.every((p) => typeof p.t === "number"));
    assert.ok(events.some((e) => e.type === "phase" && e.phase === "burn"), "应该有烤机阶段事件");
    assert.ok(events.some((e) => e.type === "sample"), "应该有采样事件");
    assert.ok(r.burnedSec >= 3 && r.burnedSec <= 15, `烤机时长异常: ${r.burnedSec}`);
    // 不能留下垃圾文件
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".niudao")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("中止：shouldStop 立刻为真时不会硬跑完，返回 cancelled 且不留残余负载", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-deep-cancel-"));
  try {
    const started = Date.now();
    const r = await runDeep({
      targetDir: dir,
      durationSec: 60,
      roundMs: 250, rounds: 1,
      shouldStop: () => Date.now() - started > 500,
    });
    assert.equal(r.cancelled, true);
    assert.ok(Date.now() - started < 20000, "中止必须及时生效");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".niudao")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
