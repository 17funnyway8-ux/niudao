#!/usr/bin/env node
/**
 * 深度档冒烟测试：用极短时长跑一遍完整链路（冷态 → 烤机 → 热态 → 分析），
 * 用来确认温度/频率采样在这个平台上真的能读到东西。
 *   node scripts/check-deep.mjs [烤机秒数，默认 20]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDeep } from "../src/server/deep.js";
import { discover, resetCache } from "../src/server/bench/thermal.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const durationSec = Math.max(5, Number(process.argv[2]) || 20);
const target = path.join(ROOT, ".data", "deep-check");
fs.mkdirSync(target, { recursive: true });

resetCache();
const caps = discover();
console.log(`传感器：CPU 温度 ${caps.hasCpuTemp ? "✓" : "✗"} · 频率 ${caps.hasFreq ? "✓" : "✗"} · 风扇 ${caps.hasFan ? "✓" : "✗"}`);
if (caps.maxFreqMhz) console.log(`标称最高频率：${caps.maxFreqMhz} MHz`);
console.log(`开始：冷态 2×3 秒 → 满载 ${durationSec} 秒 → 热态 2×3 秒\n`);

const started = Date.now();
const r = await runDeep({
  targetDir: target,
  durationSec,
  roundMs: 3000,
  rounds: 2,
  onEvent: (e) => {
    if (e.type === "phase") process.stdout.write(`  · ${e.label}\n`);
    if (e.type === "tick" && e.sample) process.stdout.write(`    ${e.burnedSec}s  ${e.sample.cpuC ?? "—"}°C  ${e.sample.freqMhz ?? "—"} MHz\n`);
  },
});

const s = r.stability;
console.log(`\n结论：${s.verdict.headline} — ${s.verdict.detail}`);
if (s.perf) console.log(`性能保持：${s.perf.preMops} → ${s.perf.postMops} MOps/s（${s.perf.keepPct}%，损失 ${s.perf.lossPct}%）`);
if (s.temp) console.log(`温度：${s.temp.startC} → ${s.temp.endC}°C，最高 ${s.temp.maxC}°C，升温 ${s.temp.riseC}°C`);
if (s.freq) console.log(`频率：峰值 ${s.freq.peakMhz} → 稳态 ${s.freq.steadyMhz} MHz（下降 ${s.freq.dropPct}%）`);
if (s.notes.length) console.log(`\n说明：\n${s.notes.map((n) => `  - ${n}`).join("\n")}`);
console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，采样点 ${r.series.length} 个`);

fs.rmSync(target, { recursive: true, force: true });
