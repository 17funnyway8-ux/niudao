/**
 * 稳定性分析（纯函数）：把烤机采到的曲线 + 前后的性能跑分，翻译成"这台机器能不能长期满载"。
 *
 * 判定原则：
 *  1. 先看**实际性能保持**（烤机后短跑 / 烤机前短跑），这比看频率更诚实 ——
 *     ARM 大小核、没暴露 cpufreq 的机器也能判；
 *  2. 频率下降只作为旁证（有些平台频率不变但 IPC 掉，反之亦然）；
 *  3. 温度只做安全提示，不参与"性能"结论 —— 90°C 的机器可能一点不掉速，但那仍然值得提醒。
 */

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

export function downsample(series, maxPoints = 240) {
  if (!Array.isArray(series) || series.length <= maxPoints) return series || [];
  const step = series.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const slice = series.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    if (!slice.length) continue;
    // 取窗口内的"最热/最高频"，避免降采样把尖峰抹平
    const pick = (key) => {
      const vals = slice.map((s) => s[key]).filter((v) => typeof v === "number");
      return vals.length ? Math.max(...vals) : null;
    };
    out.push({
      t: slice[0].t,
      cpuC: pick("cpuC"),
      freqMhz: pick("freqMhz"),
      fanRpm: pick("fanRpm"),
    });
  }
  return out;
}

/**
 * @param {object} input
 * @param {Array<{t:number,cpuC:number|null,freqMhz:number|null}>} input.series
 * @param {number|null} input.preMops 烤机前多核吞吐
 * @param {number|null} input.postMops 烤机后多核吞吐
 * @param {number} input.durationSec 实际烤机时长
 * @param {number|null} input.nominalMhz 标称最高频率
 */
export function analyzeStability({ series = [], preMops = null, postMops = null, durationSec = 0, nominalMhz = null } = {}) {
  const notes = [];
  const temps = series.filter((s) => typeof s.cpuC === "number");
  const freqs = series.filter((s) => typeof s.freqMhz === "number" && s.freqMhz > 0);

  let temp = null;
  if (temps.length >= 3) {
    const n = temps.length;
    const head = temps.slice(0, Math.max(2, Math.floor(n * 0.1))).map((s) => s.cpuC);
    const tail = temps.slice(-Math.max(2, Math.floor(n * 0.1))).map((s) => s.cpuC);
    const startC = round(avg(head));
    const endC = round(avg(tail));
    const maxC = round(Math.max(...temps.map((s) => s.cpuC)));
    const plateauThreshold = startC + 0.9 * Math.max(0, maxC - startC);
    const plateau = temps.find((s) => s.cpuC >= plateauThreshold);
    temp = {
      startC,
      endC,
      maxC,
      riseC: round(endC - startC),
      plateauSec: plateau ? Math.round(plateau.t) : null,
      samples: n,
    };
  } else {
    notes.push("没有读到 CPU 温度传感器，本次只给出频率与性能保持结论");
  }

  let freq = null;
  if (freqs.length >= 5) {
    const peakMhz = Math.round(Math.max(...freqs.map((s) => s.freqMhz)));
    const tailCount = Math.max(3, Math.floor(freqs.length * 0.3));
    const steadyMhz = Math.round(avg(freqs.slice(-tailCount).map((s) => s.freqMhz)));
    freq = {
      peakMhz,
      steadyMhz,
      nominalMhz: nominalMhz || null,
      dropPct: peakMhz > 0 ? round(((peakMhz - steadyMhz) / peakMhz) * 100) : null,
      samples: freqs.length,
    };
  } else {
    notes.push("读不到 CPU 频率，本次只给出温度与性能保持结论");
  }

  let perf = null;
  if (Number.isFinite(preMops) && Number.isFinite(postMops) && preMops > 0) {
    const keepPct = round((postMops / preMops) * 100);
    perf = {
      preMops: round(preMops),
      postMops: round(postMops),
      keepPct,
      lossPct: round(Math.max(0, 100 - keepPct)),
    };
    if (keepPct > 103) {
      notes.push("满载后成绩反而略高，属于测量噪声（或冷态时被别的进程占用），这一轮按「没有衰减」处理。");
    }
  }

  const span = durationSec < 90 ? `${Math.round(durationSec)}秒` : `${Math.round(durationSec / 60)}分钟`;
  if (durationSec > 0 && durationSec < 120) {
    notes.push("烤机时间较短（<2 分钟）：这个数字反映的是短时加速回落，不等同于长时间满载后的热平衡表现，判断长期稳定性建议跑 10 分钟档。");
  }

  // ---- 结论 ----
  let level = "unknown";
  let headline = "数据不足，无法判断";
  let detail = "";

  if (perf) {
    const keep = perf.keepPct;
    if (keep >= 97) {
      level = "good";
      headline = "散热合格";
      detail =
        keep >= 100.5
          ? `满载${span}后性能与冷态持平（差异在噪声内），这台机器可以长期跑重负载。`
          : `满载${span}后性能只差 ${perf.lossPct}%，这台机器可以长期跑重负载。`;
    } else if (keep >= 92) {
      level = "ok";
      headline = "轻微衰减";
      detail = `满载${span}后性能下降 ${perf.lossPct}%，日常够用；如果要长时间转码/编译，建议改善风道。`;
    } else if (keep >= 85) {
      level = "warn";
      headline = "明显降频";
      detail = `满载${span}后性能掉 ${perf.lossPct}%，说明散热或功耗墙压住了持续性能。长时间重负载会明显变慢。`;
    } else {
      level = "bad";
      headline = "散热吃紧";
      detail = `满载${span}后性能掉 ${perf.lossPct}%，属于"短跑猛、长跑虚"。建议清灰、换硅脂或降低功耗墙后再测。`;
    }
  } else if (freq) {
    const drop = freq.dropPct ?? 0;
    if (drop <= 5) {
      level = "good";
      headline = "频率稳定";
      detail = `满载期间频率基本没掉（峰值 ${freq.peakMhz} MHz → 稳态 ${freq.steadyMhz} MHz）。`;
    } else if (drop <= 15) {
      level = "ok";
      headline = "有轻微降频";
      detail = `满载期间频率下降 ${drop}%，属正常范围。`;
    } else {
      level = "warn";
      headline = "频率下降明显";
      detail = `满载期间频率下降 ${drop}%（${freq.peakMhz} → ${freq.steadyMhz} MHz），散热压力偏大。`;
    }
    notes.push("缺少烤机前后的性能对比，结论仅基于频率变化");
  }

  if (temp) {
    if (temp.maxC >= 95) {
      level = level === "bad" ? level : "warn";
      notes.push(`最高温度 ${temp.maxC}°C，已经很高了。长期高温会影响硬盘寿命和系统稳定性。`);
    } else if (temp.maxC >= 90) {
      notes.push(`最高温度 ${temp.maxC}°C，偏高，注意机箱进风与硬盘仓温度。`);
    }
  }

  return {
    version: 1,
    durationSec: Math.round(durationSec),
    capabilities: {
      temp: Boolean(temp),
      freq: Boolean(freq),
      fan: series.some((s) => typeof s.fanRpm === "number" && s.fanRpm > 0),
    },
    temp,
    freq,
    perf,
    verdict: { level, headline, detail },
    notes,
  };
}

export const STABILITY_LEVELS = {
  good: { label: "合格", tone: "good" },
  ok: { label: "可接受", tone: "ok" },
  warn: { label: "需注意", tone: "warn" },
  bad: { label: "不合格", tone: "bad" },
  unknown: { label: "数据不足", tone: "muted" },
};
