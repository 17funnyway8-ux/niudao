/**
 * 评分模型（纯函数，无副作用）。
 *
 * 设计原则（来自竞品教训）：
 *  1. 每个原始指标都能看到，分数只是它的可读包装；
 *  2. 维度分与综合分的权重全部公开，且可按维度单独出榜；
 *  3. 归一化基准（baseline）随套件版本一起锁定，跨版本不比较。
 */

export const SUITE_VERSION = "1.1.0";
export const CLIENT_VERSION = "2.8.1";

/** 原始指标定义：unit 展示用，better 决定除法方向 */
export const METRICS = {
  cpu_single: { label: "单核整数混算", unit: "MOps/s", better: "higher", group: "cpu" },
  cpu_multi: { label: "多核整数混算", unit: "MOps/s", better: "higher", group: "cpu" },
  crypto_aes: { label: "AES-256-GCM 吞吐", unit: "MB/s", better: "higher", group: "cpu" },
  zlib: { label: "zlib 压缩吞吐", unit: "MB/s", better: "higher", group: "cpu" },
  mem_copy: { label: "内存拷贝带宽", unit: "GB/s", better: "higher", group: "memory" },
  mem_latency: { label: "内存随机访问延迟", unit: "ns", better: "lower", group: "memory" },
  disk_seq_read: { label: "磁盘顺序读", unit: "MB/s", better: "higher", group: "storage" },
  disk_seq_write: { label: "磁盘顺序写", unit: "MB/s", better: "higher", group: "storage" },
  disk_rand_read: { label: "4K 随机读 (QD1)", unit: "IOPS", better: "higher", group: "storage" },
  disk_rand_write: { label: "4K 随机写 (QD1)", unit: "IOPS", better: "higher", group: "storage" },
};

export const METRIC_KEYS = Object.keys(METRICS);

/** 维度 → 原始指标权重（组内和为 1） */
export const DIMENSIONS = {
  cpu: {
    label: "CPU 计算",
    weight: 0.4,
    parts: { cpu_single: 0.45, cpu_multi: 0.4, crypto_aes: 0.075, zlib: 0.075 },
    blurb: "NAS 上真正吃 CPU 的活：转码、刮削、压缩、加密传输。单核决定响应，多核决定并发。",
  },
  memory: {
    label: "内存",
    weight: 0.2,
    parts: { mem_copy: 0.55, mem_latency: 0.45 },
    blurb: "大文件搬运和 Docker/虚拟机都看内存：带宽决定吞吐，延迟决定小请求快不快。",
  },
  storage: {
    label: "存储 I/O",
    weight: 0.4,
    parts: { disk_seq_read: 0.175, disk_seq_write: 0.175, disk_rand_read: 0.39, disk_rand_write: 0.26 },
    blurb: "NAS 的主战场。顺序读写对应影音/备份，4K 随机对应相册缩略图、数据库、虚拟机。",
  },
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

/** 环境技术等级，仅用于展示，不参与综合分 */
export const GRADES = [
  { grade: "S", min: 1400, label: "怪兽级", hint: "这台机器的性能已经不像家用 NAS 了。" },
  { grade: "A", min: 1150, label: "强性能", hint: "多任务、转码、虚拟机都能扛。" },
  { grade: "B", min: 900, label: "主力级", hint: "家用主力水平，日常影音与备份无压力。" },
  { grade: "C", min: 700, label: "够用级", hint: "能干活，但并发和 4K 转码要悠着点。" },
  { grade: "D", min: 0, label: "轻量级", hint: "适合做纯存储/备份，别指望它转码。" },
];

const round = (n, digits = 0) => {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** 单个指标归一化到 1000 = 基准机水平 */
/**
 * 单项封顶：**只封物理上不可能的，不封"机器真的强"的**。
 *
 * 这里原先是 SUB_CAP = 3000 一刀切，把 CPU 多核也压住了 ——
 * 一台 22 线程的 Core Ultra 7 多核 3.24 倍基准机是很正常的结果，却被削到 3000 分。
 * 算力没有物理天花板，只有 I/O 有。
 *
 * 封顶值是**用物理上限换算出来的**，不是一个拍脑袋的固定分数：
 * 基准机是 SATA 盘（读 419 / 写 202 MB/s），直接拿"基准的 N 倍"当上限，
 * 会误伤真实的 NVMe 池（读写 6–7 GB/s = 基准的 15–30 倍）。
 *
 * PHYSICAL_MAX 的含义是"现实硬件到不了这个数"：
 *   · 磁盘顺序读 8000 MB/s：PCIe 4.0 单盘约 7000，再高就要靠多盘阵列
 *   · 磁盘顺序写 7000 MB/s：同一代盘写入通常略低于读
 *   · 4K 随机 50000 IOPS @QD1：消费级旗舰约 20–30k，企业级 Optane 也就 30k 上下
 *   · 内存延迟 25 ns：DDR5 实测 40–70ns，25ns 已低于任何真实 DRAM
 * 超过这些数，只能是被缓存/虚拟化放大出来的假值。
 *
 * 算力类（CPU 单核/多核、AES、zlib、内存带宽）**不封顶**：机器强就是强。
 */
export const PHYSICAL_MAX = {
  mem_latency: { min: 25 }, // 延迟越低越好，这里给下限
  disk_seq_read: 8000, // MB/s
  disk_seq_write: 7000, // MB/s
  disk_rand_read: 50000, // IOPS (QD1)
  disk_rand_write: 50000,
};

/** 某个指标的分数上限；null 表示不封顶。由物理上限与基准值换算而来。 */
export function capOf(key, baselines) {
  const spec = PHYSICAL_MAX[key];
  const base = baselines?.[key];
  if (!spec || !Number.isFinite(base) || base <= 0) return null;
  if (Number.isFinite(spec.min)) return Math.round((base / spec.min) * 1000);
  return Math.round((spec / base) * 1000);
}

export function normalizeMetric(key, raw, baselines) {
  const def = METRICS[key];
  const base = baselines?.[key];
  if (!def || !Number.isFinite(raw) || raw <= 0 || !Number.isFinite(base) || base <= 0) return null;
  const value = def.better === "higher" ? (raw / base) * 1000 : (base / raw) * 1000;
  const cap = capOf(key, baselines);
  return cap !== null && value > cap ? cap : value;
}

/** 该指标是否触顶（用于在报告里标注"物理上不可能，分数已封顶"） */
export function isCapped(key, raw, baselines) {
  const def = METRICS[key];
  const base = baselines?.[key];
  const cap = capOf(key, baselines);
  if (cap === null) return false;
  if (!def || !Number.isFinite(raw) || !Number.isFinite(base) || base <= 0) return false;
  const value = def.better === "higher" ? (raw / base) * 1000 : (base / raw) * 1000;
  return value > cap;
}

/**
 * 计算全部分数。
 * @param {Record<string, number>} metrics 原始指标
 * @param {Record<string, number>} baselines 基准值（同套件版本）
 * @returns {{subs: object, dims: object, composite: number, coverage: number, partial: boolean}}
 */
export function computeScores(metrics, baselines) {
  const subs = {};
  const capped = [];
  for (const key of METRIC_KEYS) {
    const s = normalizeMetric(key, Number(metrics?.[key]), baselines);
    if (s !== null) {
      subs[key] = round(s, 1);
      if (isCapped(key, Number(metrics[key]), baselines)) capped.push(key);
    }
  }

  const dims = {};
  let totalWeight = 0;
  let weighted = 0;
  for (const [dimKey, dim] of Object.entries(DIMENSIONS)) {
    let sum = 0;
    let used = 0;
    for (const [mKey, w] of Object.entries(dim.parts)) {
      if (subs[mKey] !== undefined) {
        sum += subs[mKey] * w;
        used += w;
      }
    }
    if (used > 0) {
      const score = round(sum / used, 1);
      dims[dimKey] = { score, coverage: round(used, 2) };
      weighted += score * dim.weight;
      totalWeight += dim.weight;
    } else {
      dims[dimKey] = { score: null, coverage: 0 };
    }
  }

  const composite = totalWeight > 0 ? round(weighted / totalWeight, 0) : 0;
  const coverage = round(METRIC_KEYS.filter((k) => subs[k] !== undefined).length / METRIC_KEYS.length, 2);
  return { subs, dims, composite, coverage, capped, partial: totalWeight < 1 || coverage < 1 || capped.length > 0 };
}

export function gradeOf(composite) {
  return GRADES.find((g) => composite >= g.min) ?? GRADES[GRADES.length - 1];
}

/** 由指标直接给出可读的一行结论（用于报告头部） */
export function headline(scores) {
  const { dims, composite } = scores;
  const g = gradeOf(composite);
  const weakest = Object.entries(dims)
    .filter(([, v]) => v.score !== null)
    .sort((a, b) => a[1].score - b[1].score)[0];
  const strongest = Object.entries(dims)
    .filter(([, v]) => v.score !== null)
    .sort((a, b) => b[1].score - a[1].score)[0];
  return {
    grade: g.grade,
    gradeLabel: g.label,
    gradeHint: g.hint,
    strongest: strongest ? { key: strongest[0], label: DIMENSIONS[strongest[0]].label, score: strongest[1].score } : null,
    weakest: weakest ? { key: weakest[0], label: DIMENSIONS[weakest[0]].label, score: weakest[1].score } : null,
  };
}

/** 在升序分数数组里求百分位（0-100，越大越好） */
export function percentileOf(value, sortedAsc) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0 || !Number.isFinite(value)) return null;
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  const below = lo;
  const equal = (() => {
    let n = 0;
    for (let i = lo; i < sortedAsc.length && sortedAsc[i] === value; i += 1) n += 1;
    return n;
  })();
  const pct = ((below + equal * 0.5) / sortedAsc.length) * 100;
  return round(pct, 1);
}

/** 人的可读指标值 */
export function formatMetric(key, value) {
  const def = METRICS[key];
  if (!def || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${round(value, 0).toLocaleString("en-US")} ${def.unit}`;
  if (value >= 10) return `${round(value, 1)} ${def.unit}`;
  return `${round(value, 2)} ${def.unit}`;
}
