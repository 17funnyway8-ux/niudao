/**
 * 榜单存储：JSONL 追加 + 内存索引。
 * 家用/小社区规模（万级条目）足够；不引数据库依赖，方便随手部署和备份。
 */
import fs from "node:fs";
import path from "node:path";

/** 样本门槛：少于这个数量不显示百分位（对齐 Speedtest Global Index 的"样本不足不上榜"） */
export const MIN_SAMPLES = 30;

/**
 * 榜上"这个人是谁"的判定键。
 * 花名只是显示名，不保证唯一；真正区分机器的是 fingerprint。
 * 这里给前端一个短键（不是完整指纹），让客户端能判断"这一行是不是我自己"，
 * 同时两边都用同一套规则算，避免口径漂移。
 */
/** 花名归一（去空格、小写）：只用来判断"重名" */
export function aliasKey(entry) {
  return String(entry?.alias || "").trim().toLowerCase();
}

export function nameKey(entry) {
  const fp = String(entry?.fingerprint || "").slice(0, 8);
  const name = String(entry?.alias || "").trim().toLowerCase();
  return `${name}#${fp}`;
}

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
    // 反馈单独一个文件：它和成绩不是一个生命周期，别混在一起
    this.feedbackFile = path.join(path.dirname(file), "feedback.jsonl");
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
  ranked(suite, arch, cpu = "", track = "all") {
    const out = [];
    for (const e of this.best.values()) {
      if (suite && e.suite !== suite) continue;
      if (arch && e.arch !== arch) continue;
      // 同型号：只看同一颗 CPU，玩家真正想比的就是这个
      if (cpu) {
        // unknown 型号不参与同型号筛选：识别失败的机器不该被当成"同一型号"
        const model = (e.hardware?.cpu_model || "").trim();
        if (!model || /^unknown$/i.test(model) || model !== cpu) continue;
      }
      if (track === "physical" && (e.env_type || "physical") !== "physical") continue;
      if (track === "vm" && !["vm", "container"].includes(e.env_type || "")) continue;
      out.push(e);
    }
    return out;
  }

  valueOf(entry, dim) {
    if (dim === "overall") return entry.scores.composite;
    const d = entry.scores.dims?.[dim];
    return d && Number.isFinite(d.score) ? d.score : null;
  }

  leaderboard({ dim = "overall", suite = "", arch = "", cpu = "", track = "all", limit = 50, offset = 0, score = null, excludeId = null, fingerprint = "" }) {
    // 注意：fingerprint 只用来"认出哪一行是我"，绝不能用它过滤榜单 ——
    // 否则自己的榜单会被筛成只剩自己一条。
    const pool = this.ranked(suite, arch, cpu, track)
      .map((e) => ({ e, v: this.valueOf(e, dim) }))
      .filter((x) => Number.isFinite(x.v))
      .sort((a, b) => b.v - a.v || (a.e.ts || 0) - (b.e.ts || 0));

    const total = pool.length;
    // 认"这是我"：优先按条目 id，其次按指纹（调用方可能只知道自己这一版套件的条目）
    const mine = fingerprint
      ? pool.find((x) => x.e.fingerprint === fingerprint)?.e.id || ""
      : "";
    // 重名 = 花名相同但机器不同。按"花名"计数，不是按 nameKey
    //（nameKey 里含指纹，按它数永远是 1，等于没做重名检测）
    const nameCounts = new Map();
    for (const x of pool) {
      const k = aliasKey(x.e);
      nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
    }
    const entries = pool.slice(offset, offset + limit).map((x, i) => ({
      rank: offset + i + 1,
      id: x.e.id,
      alias: x.e.alias || "",
      // 重名不是错，但必须让用户知道"这不是我"：nameKey 用来比对，dup 用来标"重名"
      nameKey: nameKey(x.e),
      dup: (nameCounts.get(aliasKey(x.e)) || 0) > 1,
      // isMine 的兜底语义：指纹相同也算我（自托管端按指纹认，Worker 端按 id 认）
      isMine: Boolean(fingerprint) && (x.e.id === mine || x.e.fingerprint === fingerprint),
      value: x.v,
      composite: x.e.scores.composite,
      envType: x.e.env_type || "physical",
      vmTech: x.e.vm_tech || "",
      arch: x.e.arch,
      ts: x.e.ts,
      suite: x.e.suite,
      // 只给「看得懂硬件」需要的字段。volume / disks 是算分用的，不外发 ——
      // 那等于把用户的目录结构与磁盘布局贴到公网上。
      hardware: {
        cpu_model: x.e.hardware?.cpu_model || "",
        mem_gb: x.e.hardware?.mem_gb || 0,
        threads: x.e.hardware?.threads || 0,
        board: x.e.hardware?.board || "",
        os_version: x.e.hardware?.os_version || "",
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

  /** 反馈：追加一行 JSONL，字段都在服务端脱敏过 */
  addFeedback(entry) {
    fs.appendFileSync(this.feedbackFile, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  listFeedback(limit = 30) {
    let raw = "";
    try {
      raw = fs.readFileSync(this.feedbackFile, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.received_at - a.received_at)
      .slice(0, limit);
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
