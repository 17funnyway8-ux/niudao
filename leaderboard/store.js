/**
 * 榜单存储：JSONL 追加 + 内存索引。
 * 家用/小社区规模（万级条目）足够；不引数据库依赖，方便随手部署和备份。
 */
import fs from "node:fs";
import path from "node:path";

/** 样本门槛：少于这个数量不显示百分位（对齐 Speedtest Global Index 的"样本不足不上榜"） */
export const MIN_SAMPLES = 30;

/** 中位数与 95% 置信区间（顺序统计量法，不假设分布） */
export function medianCI(sortedAsc) {
  const n = sortedAsc.length;
  if (!n) return { median: null, ci: null };
  const median = n % 2 ? sortedAsc[(n - 1) / 2] : (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
  if (n < 8) return { median, ci: null };
  const k = Math.max(0, Math.floor(n / 2 - 1.96 * Math.sqrt(n) / 2));
  return { median, ci: [sortedAsc[k], sortedAsc[n - 1 - k]] };
}

export class Store {
  constructor(file) {
    this.file = file;
    this.all = [];
    this.best = new Map(); // `${fingerprint}|${suite}` -> entry
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.load();
  }

  load() {
    let raw = "";
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        this.all.push(e);
        this.index(e);
      } catch {
        /* 跳过坏行 */
      }
    }
  }

  index(entry) {
    const key = `${entry.fingerprint}|${entry.suite}`;
    const prev = this.best.get(key);
    if (!prev || entry.scores.composite > prev.scores.composite) this.best.set(key, entry);
  }

  add(entry) {
    this.all.push(entry);
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    this.index(entry);
    return entry;
  }

  /** 某维度下参与排名的机器（每台机器取其最好成绩） */
  ranked(suite, arch) {
    const out = [];
    for (const e of this.best.values()) {
      if (suite && e.suite !== suite) continue;
      if (arch && e.arch !== arch) continue;
      out.push(e);
    }
    return out;
  }

  valueOf(entry, dim) {
    if (dim === "overall") return entry.scores.composite;
    const d = entry.scores.dims?.[dim];
    return d && Number.isFinite(d.score) ? d.score : null;
  }

  leaderboard({ dim = "overall", suite = "", arch = "", limit = 50, offset = 0, score = null, excludeId = null }) {
    const pool = this.ranked(suite, arch)
      .map((e) => ({ e, v: this.valueOf(e, dim) }))
      .filter((x) => Number.isFinite(x.v))
      .sort((a, b) => b.v - a.v || (a.e.ts || 0) - (b.e.ts || 0));

    const total = pool.length;
    const entries = pool.slice(offset, offset + limit).map((x, i) => ({
      rank: offset + i + 1,
      id: x.e.id,
      alias: x.e.alias || "",
      value: x.v,
      composite: x.e.scores.composite,
      arch: x.e.arch,
      ts: x.e.ts,
      suite: x.e.suite,
      hardware: {
        cpu_model: x.e.hardware?.cpu_model || "",
        mem_gb: x.e.hardware?.mem_gb || 0,
        threads: x.e.hardware?.threads || 0,
        board: x.e.hardware?.board || "",
      },
    }));

    const values = pool.map((x) => x.v).sort((a, b) => a - b);
    const stats = (() => {
      const { median, ci } = medianCI(values);
      return {
        n: total,
        median,
        ci,
        gated: total < MIN_SAMPLES,
        needed: total < MIN_SAMPLES ? MIN_SAMPLES - total : 0,
      };
    })();

    let me = null;
    if (Number.isFinite(score)) {
      // 并列同名次（competition ranking）：rank = 严格高于我的机器数 + 1
      const aheadList = pool.filter((x) => x.v > score);
      const equal = pool.filter((x) => x.v === score).length;
      const behindList = pool.filter((x) => x.v < score);
      const rank = aheadList.length + 1;
      me = {
        rank,
        value: score,
        total,
        percentile:
          total >= MIN_SAMPLES ? Math.round(((behindList.length + equal * 0.5) / total) * 1000) / 10 : null,
        above: aheadList.length
          ? { rank: aheadList.length, value: aheadList[aheadList.length - 1].v, hardware: aheadList[aheadList.length - 1].e.hardware, alias: aheadList[aheadList.length - 1].e.alias }
          : null,
        below: behindList.length
          ? { rank: aheadList.length + equal + 1, value: behindList[0].v, hardware: behindList[0].e.hardware, alias: behindList[0].e.alias }
          : null,
      };
    }

    // 分布直方图（每 100 分一档），给前端画柱状图
    const buckets = {};
    for (const x of pool) {
      const b = Math.floor(x.v / 100) * 100;
      buckets[b] = (buckets[b] || 0) + 1;
    }

    return { dim, suite: suite || null, arch: arch || null, total, offset, limit, entries, me, buckets, stats };
  }

  byFingerprint(fingerprint) {
    return this.all
      .filter((e) => e.fingerprint === fingerprint)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  remove(id) {
    const idx = this.all.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.all.splice(idx, 1);
    this.best = new Map();
    for (const e of this.all) this.index(e);
    this.compact();
    return true;
  }

  compact() {
    const body = this.all.map((e) => JSON.stringify(e)).join("\n");
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body ? `${body}\n` : "");
    fs.renameSync(tmp, this.file);
  }

  stats() {
    const suites = {};
    const archs = {};
    for (const e of this.best.values()) {
      suites[e.suite] = (suites[e.suite] || 0) + 1;
      archs[e.arch] = (archs[e.arch] || 0) + 1;
    }
    return { machines: this.best.size, submissions: this.all.length, suites, archs };
  }
}
