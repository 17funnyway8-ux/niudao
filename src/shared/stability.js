/**
 * 稳定性分析（纯函数）。
 *
 * 主判定采用 3DMark 压力测试的思路：**满载期间逐轮测吞吐，稳定性 = 最差轮 / 最好轮 × 100**。
 * 为什么不用"冷态 vs 热态"两点相比：冷态跑分里含加速预算（boost budget），
 * 会把"短时加速回落"误判成"散热不行"。逐轮相比只看同一次持续负载内部的波动，干净得多。
 * 冷/热对比保留为辅助信息（boost），说明"加速回落了多少"。
 *
 * 温度与频率只作旁证与安全提醒，不参与稳定性判定。
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
    const pick = (key) => {
      const vals = slice.map((s) => s[key]).filter((v) => typeof v === "number");
      return vals.length ? Math.max(...vals) : null;
    };
    out.push({ t: slice[0].t, cpuC: pick("cpuC"), freqMhz: pick("freqMhz"), fanRpm: pick("fanRpm") });
  }
  return out;
}

/**
 * 逐轮吞吐 → 稳定性。热身段由上游按时间窗口排除，这里只丢掉最后不足一轮的残段。
 */
export function roundsToStability(rounds) {
  const list = (rounds || []).filter((r) => Number.isFinite(r.mops) && r.mops > 0);
  if (list.length < 3) return null;
  const kept = list.slice(0, list.length - 1);
  const best = Math.max(...kept.map((r) => r.mops));
  const worst = Math.min(...kept.map((r) => r.mops));
  if (!(best > 0)) return null;
  return {
    pct: round((worst / best) * 100),
    bestMops: round(best),
    worstMops: round(worst),
    rounds: kept.length,
    values: kept.map((r) => round(r.mops)),
  };
}

/**
 * @param {object} input
 * @param {Array<{t:number,cpuC:number|null,freqMhz:number|null}>} input.series 温频采样
 * @param {Array<{t:number,mops:number}>} input.rounds 满载期间逐轮吞吐
 * @param {number|null} input.preMops 冷态多核（最好值）
 * @param {number|null} input.postMops 热态多核（最好值）
 */
export function analyzeStability({
  series = [],
  rounds = [],
  preMops = null,
  postMops = null,
  durationSec = 0,
  nominalMhz = null,
  warmupSec = null,
} = {}) {
  const notes = [];
  const temps = series.filter((s) => typeof s.cpuC === "number");
  const freqs = series.filter((s) => typeof s.freqMhz === "number" && s.freqMhz > 0);

  // ---- 温度 ----
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
    temp = { startC, endC, maxC, riseC: round(endC - startC), plateauSec: plateau ? Math.round(plateau.t) : null, samples: n };
  } else {
    notes.push("没有读到 CPU 温度传感器，本次只给出频率与性能结论");
  }

  // ---- 频率 ----
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
    notes.push("读不到 CPU 频率，本次只给出温度与性能结论");
  }

  // ---- 稳定性（逐轮）----
  const steady = roundsToStability(rounds);
  if (steady) {
    notes.push("稳定性 = 满载期间最差一轮吞吐 ÷ 最好一轮吞吐；≥97% 判合格（对齐 3DMark 压力测试的判定口径）");
  }

  // ---- 加减速回落（辅助）----
  let boost = null;
  if (Number.isFinite(preMops) && Number.isFinite(postMops) && preMops > 0) {
    const keepPct = round((postMops / preMops) * 100);
    boost = {
      coldMops: round(preMops),
      hotMops: round(postMops),
      keepPct,
      dropPct: round(Math.max(0, 100 - keepPct)),
    };
  }

  const span = durationSec < 90 ? `${Math.round(durationSec)}秒` : `${Math.round(durationSec / 60)}分钟`;

  // ---- 结论：优先用逐轮稳定性 ----
  // 档位设计原则（对标 3DMark 压力测试的 97% 线，但把"家用 NAS"的实际情况摊开）：
  //   97% 以上：几乎无衰减 —— 家用 3DMark 同款合格线
  //   94–97%： 轻微衰减。热点温度高一点、风扇策略保守，都会落在这里，不算问题
  //   88–94%： 明显降频。能感知到，转码/编译时间会变长
  //   <88%：   散热吃紧或功耗墙过严。属于"短跑猛、长跑虚"
  // 原来的 92/85 两档太粗：94% 这种很常见的健康机器会被叫成"轻微衰减"，
  // 而 86% 和 60% 都被塞进同一个"散热吃紧"，没有区分度。
  const TIERS = [
    { min: 97, level: "good", headline: "散热合格", hint: "持续负载下性能几乎不掉，可以长期跑重活。" },
    { min: 94, level: "ok", headline: "轻微衰减", hint: "高温段有温和降速，日常使用基本无感。" },
    { min: 88, level: "warn", headline: "明显降频", hint: "转码、编译这类长任务会明显变慢。" },
    { min: 0, level: "bad", headline: "散热吃紧", hint: "建议清灰、换硅脂，或把功耗墙松开一点。" },
  ];
  const tierOf = (pct) => TIERS.find((t) => pct >= t.min) || TIERS[TIERS.length - 1];

  let level = "unknown";
  let headline = "数据不足，无法判断";
  let detail = "";
  let tier = null;

  if (steady) {
    const pct = steady.pct;
    tier = tierOf(pct);
    level = tier.level;
    headline = tier.headline;
    const drop = (100 - pct).toFixed(1);
    const extra = [
      `逐轮性能波动 ${drop}%（最差 ${steady.worstMops} / 最好 ${steady.bestMops} MOps/s）`,
      tier.hint,
    ];
    // 逐轮离散度大：说明期间还有别的负载在抢 CPU，结论要打折
    if (steady && steady.values?.length > 2) {
      const vals = steady.values;
      const spread = ((Math.max(...vals) - Math.min(...vals)) / Math.max(...vals)) * 100;
      if (spread > 5) extra.push(`注意：各轮之间波动 ${spread.toFixed(1)}%，期间可能有别的任务在抢 CPU，结论仅供参考`);
    }
    detail = `满载${span}，${extra.join("；")}。`;
  } else if (boost) {
    const keep = boost.keepPct;
    tier = tierOf(keep);
    level = tier.level;
    headline = tier.headline;
    detail = `满载${span}后性能变为冷态的 ${keep}%（掉 ${boost.dropPct}%）；${tier.hint}` +
      "（逐轮样本不足，退回「冷态 vs 热态」口径）";
    notes.push("满载期间只采到不足 3 轮吞吐，稳定性退回「冷态 vs 热态」口径，精度较低（建议跑 3 分钟以上）");
  } else if (freq) {
    const drop = freq.dropPct ?? 0;
    // 频率档位同样分四档，但阈值不同：频率掉 15% 不代表性能掉 15%（功耗墙会先压频率）
    if (drop <= 5) {
      level = "good";
      headline = "频率稳定";
      detail = `满载期间频率基本没掉（峰值 ${freq.peakMhz} MHz → 稳态 ${freq.steadyMhz} MHz）。`;
    } else if (drop <= 12) {
      level = "ok";
      headline = "有轻微降频";
      detail = `满载期间频率下降 ${drop}%（${freq.peakMhz} → ${freq.steadyMhz} MHz），属正常范围。`;
    } else if (drop <= 25) {
      level = "warn";
      headline = "频率下降明显";
      detail = `满载期间频率下降 ${drop}%（${freq.peakMhz} → ${freq.steadyMhz} MHz），散热压力偏大。`;
    } else {
      level = "bad";
      headline = "频率掉得厉害";
      detail = `满载期间频率下降 ${drop}%（${freq.peakMhz} → ${freq.steadyMhz} MHz），基本是靠降频在硬撑。`;
    }
    notes.push("缺少性能对比数据，结论仅基于频率变化");
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
    version: 2,
    warmupSec,
    durationSec: Math.round(durationSec),
    capabilities: {
      temp: Boolean(temp),
      freq: Boolean(freq),
      fan: series.some((s) => typeof s.fanRpm === "number" && s.fanRpm > 0),
    },
    stability: steady,
    boost,
    temp,
    freq,
    /** 兼容旧字段名：以前叫 perf */
    perf: boost
      ? { preMops: boost.coldMops, postMops: boost.hotMops, keepPct: boost.keepPct, lossPct: boost.dropPct }
      : null,
    rounds: (rounds || []).map((r) => ({ t: Math.round(r.t), mops: round(r.mops) })),
    verdict: { level, headline, detail, tier: tier ? { min: tier.min, label: tier.headline } : null },
    /** 判定档位表：报告里直接展示，用户不用猜"多少算合格" */
    tiers: TIERS.map((t) => ({ min: t.min, label: t.headline, level: t.level, hint: t.hint })),
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
