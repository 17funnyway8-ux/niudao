/** 稳定性分析器：纯函数，逐条钉住"结论是怎么算出来的"。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeStability, downsample } from "../src/shared/stability.js";

/** 造一段曲线：从 startC 升温到 maxC，频率从 peak 掉到 steady */
function series({ seconds = 60, startC = 40, maxC = 80, plateauAt = 20, peakMhz = 3000, steadyMhz = 2900 } = {}) {
  const out = [];
  for (let t = 0; t <= seconds; t += 1) {
    const heat = Math.min(1, t / Math.max(1, plateauAt));
    const cpuC = Math.round((startC + (maxC - startC) * heat) * 10) / 10;
    const freqMhz = Math.round(peakMhz - (peakMhz - steadyMhz) * heat);
    out.push({ t, cpuC, freqMhz, fanRpm: null });
  }
  return out;
}

test("散热良好：性能保持 99% → good，温度/频率数据齐全", () => {
  const s = analyzeStability({ series: series(), preMops: 14000, postMops: 13860, durationSec: 600 });
  assert.equal(s.verdict.level, "good");
  assert.equal(s.perf.keepPct, 99);
  assert.equal(s.perf.lossPct, 1);
  assert.equal(s.temp.maxC, 80);
  assert.ok(s.temp.plateauSec !== null && s.temp.plateauSec <= 22, "到达 90% 稳态的时间应接近 plateauAt");
  assert.equal(s.capabilities.temp, true);
  assert.equal(s.capabilities.freq, true);
});

test("四档结论按保持率分档：99/94/88/70", () => {
  const lv = (keep) =>
    analyzeStability({ series: series(), preMops: 10000, postMops: 10000 * (keep / 100), durationSec: 600 }).verdict.level;
  assert.equal(lv(99), "good");
  assert.equal(lv(94), "ok");
  assert.equal(lv(88), "warn");
  assert.equal(lv(70), "bad");
});

test("频率下降只作旁证，不推翻性能结论", () => {
  const s = analyzeStability({
    series: series({ peakMhz: 4000, steadyMhz: 2400 }),
    preMops: 10000,
    postMops: 9950,
    durationSec: 600,
  });
  assert.equal(s.verdict.level, "good", "性能没掉就是 good，哪怕频率掉了一半");
  assert.equal(s.freq.dropPct, 40);
});

test("没有性能对比时退回频率判断，并明确说明依据", () => {
  const s = analyzeStability({ series: series({ peakMhz: 3000, steadyMhz: 2400 }), preMops: null, postMops: null, durationSec: 600 });
  assert.equal(s.verdict.level, "warn");
  assert.match(s.notes.join(), /仅基于频率/);
});

test("没有温度传感器时只说没有，不编数字", () => {
  const noTemp = series().map((p) => ({ ...p, cpuC: null }));
  const s = analyzeStability({ series: noTemp, preMops: 10000, postMops: 9900, durationSec: 600 });
  assert.equal(s.temp, null);
  assert.match(s.notes.join(), /温度传感器/);
  assert.equal(s.verdict.level, "good");
});

test("高温告警：≥90°C 提示，≥95°C 升级为需注意", () => {
  const hot = analyzeStability({ series: series({ maxC: 91 }), preMops: 10000, postMops: 10000, durationSec: 600 });
  assert.match(hot.notes.join(), /偏高/);
  const hotter = analyzeStability({ series: series({ maxC: 96 }), preMops: 10000, postMops: 10000, durationSec: 600 });
  assert.match(hotter.notes.join(), /很高/);
  assert.notEqual(hotter.verdict.level, "good");
});

test("完全没有数据时不瞎猜", () => {
  const s = analyzeStability({ series: [], preMops: null, postMops: null, durationSec: 0 });
  assert.equal(s.verdict.level, "unknown");
  assert.equal(s.temp, null);
  assert.equal(s.freq, null);
  assert.equal(s.perf, null);
});

test("降采样保留峰值而不是平均值", () => {
  const long = [];
  for (let t = 0; t < 600; t += 1) long.push({ t, cpuC: t === 300 ? 99 : 50, freqMhz: t === 300 ? 4000 : 2000, fanRpm: null });
  const out = downsample(long, 60);
  assert.ok(out.length <= 60);
  assert.equal(Math.max(...out.map((p) => p.cpuC)), 99, "尖峰不能被抹平");
  assert.equal(out[0].t, 0);
});
