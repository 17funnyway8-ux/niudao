/**
 * 套件编排：顺序执行各阶段，逐阶段上报进度，单阶段失败不拖垮整体。
 * 顺序刻意如此——先 CPU 后内存再磁盘，避免磁盘测试的缓存残留影响其它项。
 */
import { cpuMulti, cpuSingle, scalingEfficiency } from "./bench/cpu.js";
import { runBenchJob } from "./bench/offload.js";
import { diskRandom, diskSeq, prepareDir } from "./bench/disk.js";
import { discover as discoverSensors, startSampler } from "./bench/thermal.js";

export const STAGES = [
  { key: "cpu_single", label: "CPU 单核", hint: "让一个核心跑满，看你点开应用的响应速度" },
  { key: "cpu_multi", label: "CPU 多核", hint: "所有核心同时跑，看并发能力" },
  { key: "crypto", label: "加密与压缩", hint: "SMB 加密传输、备份压缩的真实吞吐" },
  { key: "memory", label: "内存带宽与延迟", hint: "大文件搬运与元数据小请求" },
  { key: "disk_seq", label: "磁盘顺序读写", hint: "影音播放、大文件备份的速度" },
  { key: "disk_random", label: "磁盘 4K 随机", hint: "相册缩略图、数据库、虚拟机的手感" },
];

const DEFAULTS = {
  cpuSingleMs: 5000,
  cpuMultiMs: 5000,
  diskSizeMb: 512,
  diskFileMb: 512,
  diskSeconds: 6,
};

/**
 * @param {{targetDir: string, onEvent?: Function, opts?: object}} cfg
 */
export async function runSuite({ targetDir, onEvent = () => {}, opts = {} }) {
  const cfg = { ...DEFAULTS, ...opts };
  const metrics = {};
  const durations = {};
  const caveats = [];
  const errors = [];
  const detail = {};
  const total = STAGES.length;
  const t0 = Date.now();

  const emit = (payload) => {
    try {
      onEvent({ ...payload, total, elapsedMs: Date.now() - t0 });
    } catch {
      /* 上报失败不影响测试 */
    }
  };

  // 实时数值流：跑分时不让用户只看一根进度条。CPU 吞吐、磁盘速率、温度每秒上报一次。
  const live = (payload) => emit({ type: "live", ...payload });
  // 每秒采样：既给界面看实时温度，也攒下来算"CPU 实际工作频率"。
  // 必须按阶段打标：磁盘/内存阶段 CPU 基本空闲，把它们混进去会把平均频率拉低。
  const cpuFreqSamples = [];
  let currentStage = null;
  const sampler = startSampler((s) => {
    live({ temp: s });
    if (Number.isFinite(s?.freqMhz) && s.freqMhz > 0) {
      cpuFreqSamples.push({ t: s.t, stage: currentStage, avg: s.freqMhz, max: s.freqMaxMhz });
    }
  }, 1000);
  // 让 UI 在每个阶段开始时清掉上一阶段的实时数字（避免磁盘速率还挂在 CPU 阶段上）
  live({ stage: null });

  const step = async (index, fn) => {
    if (opts.shouldStop?.()) return null;
    const stage = STAGES[index];
    currentStage = stage.key;
    live({ stage: stage.key });
    emit({ type: "stage", stage: stage.key, label: stage.label, index, status: "start" });
    const started = Date.now();
    try {
      const out = await fn();
      durations[stage.key] = Date.now() - started;
      emit({ type: "stage", stage: stage.key, label: stage.label, index, status: "done", ms: durations[stage.key] });
      return out;
    } catch (err) {
      durations[stage.key] = Date.now() - started;
      errors.push(`${stage.label}: ${err?.message || err}`);
      emit({ type: "stage", stage: stage.key, label: stage.label, index, status: "error", message: String(err?.message || err) });
      return null;
    }
  };

  prepareDir(targetDir);

  const single = await step(0, () => cpuSingle(cfg.cpuSingleMs));
  if (single) {
    metrics.cpu_single = Math.round(single.mops * 10) / 10;
    detail.cpu_single = single.detail;
    // 两轮差得多，说明这个数字不稳（大小核调度、后台负载、降频都可能导致）
    if (Number.isFinite(single.detail?.spreadPct) && single.detail.spreadPct > 12) {
      caveats.push(
        `单核两轮波动 ${single.detail.spreadPct}%（${(single.detail.allMops || []).join(" / ")} MOps/s），可能被调度到能效核或有其他任务干扰，分数偏保守。`,
      );
    }
    if (single.detail?.topology?.hybrid) {
      caveats.push(`检测到混合架构（${single.detail.topology.pCores.length} 性能核 + ${single.detail.topology.eCores.length} 能效核），单核测试已钉在 P 核上。`);
    }
  }

  const multi = await step(1, () => cpuMulti(cfg.cpuMultiMs, { onProgress: (p) => live({ cpuMulti: p }) }));
  if (multi) {
    metrics.cpu_multi = Math.round(multi.mops * 10) / 10;
    detail.cpu_multi = multi.detail;
    detail.scaling = scalingEfficiency(single?.mops, multi.mops, multi.detail.threads);
  }

  // 这两项都是同步的原生计算（OpenSSL / deflateSync / 随机访存），
  // 放主线程会把 http 服务冻住 2–3 秒，所以整体丢进 worker 跑。
  // 测量代码本身没变，分数与历史成绩可比。
  await step(2, async () => {
    const { aes, zlib: z } = await runBenchJob("crypto");
    metrics.crypto_aes = aes.mbs;
    metrics.zlib = z.mbs;
    detail.crypto = { ...aes.detail, ...z.detail };
    return true;
  });

  await step(3, async () => {
    const { bw, lat } = await runBenchJob("memory");
    metrics.mem_copy = bw.gbs;
    metrics.mem_latency = lat.ns;
    detail.memory = { ...bw.detail, ...lat.detail };
    return true;
  });

  await step(4, async () => {
    const seq = await diskSeq(targetDir, { sizeMb: cfg.diskSizeMb, onProgress: (p) => live({ diskSeq: p }) });
    metrics.disk_seq_read = seq.read_mbs;
    metrics.disk_seq_write = seq.write_mbs;
    detail.disk_seq = seq.detail;
    caveats.push(...(seq.caveats || []));
    return true;
  });

  await step(5, async () => {
    const rand = await diskRandom(targetDir, { fileMb: cfg.diskFileMb, seconds: cfg.diskSeconds, onProgress: (p) => live({ diskRandom: p }) });
    if (rand.read_iops) metrics.disk_rand_read = rand.read_iops;
    if (rand.write_iops) metrics.disk_rand_write = rand.write_iops;
    // 延迟随 IOPS 一起上报：它是判断"这个 IOPS 到底来自磁盘还是页缓存"的唯一依据。
    // QD1 下 IOPS = 1e6/延迟(μs)，延迟低于 10μs 就只可能是内存。
    if (rand.detail?.readLatUs) metrics.disk_rand_read_lat_us = rand.detail.readLatUs;
    if (rand.detail?.writeLatUs) metrics.disk_rand_write_lat_us = rand.detail.writeLatUs;
    detail.disk_random = rand.detail;
    caveats.push(...(rand.caveats || []));
    return true;
  });

  sampler.stop();
  // 测试期间的工作频率 —— 同型号 CPU 开不开睿频，分数差得很多。
  //
  // 这里有个**必须区分口径**的地方，不区分会得出完全错误的结论：
  //  · 单核阶段只有 1 个核在跑，其余核空闲降频。取所有核的平均，会得到
  //    "4.5 GHz 的核 + 15 个 1.4 GHz 的空闲核" → 平均 1.6 GHz，
  //    看起来像"单核跑不满"。所以单核阶段必须看**峰值**。
  //  · 全核阶段所有核都在跑，平均才有意义，峰值则反映散热余量。
  const byStage = (keys) => cpuFreqSamples.filter((x) => keys.includes(x.stage));
  const stat = (rows, field) => {
    const vals = rows.map((x) => x[field]).filter((v) => Number.isFinite(v) && v > 0);
    if (!vals.length) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
      max: Math.max(...vals),
      min: Math.min(...vals),
      p95: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))],
      samples: vals.length,
    };
  };

  detail.cpuClock = (() => {
    if (!cpuFreqSamples.length) return { available: false, reason: "这台机器读不到 CPU 频率（缺 cpufreq 或权限）" };
    // 内核报告的最高频率（硬件能力）。实测峰值明显低于它，说明睿频没生效。
    const nominalMhz = discoverSensors()?.maxFreqMhz || null;
    const single = byStage(["cpu_single"]).length ? byStage(["cpu_single"]) : byStage(["cpu_single", "cpu_multi"]);
    const multi = byStage(["cpu_multi"]);
    const singlePeak = stat(single, "max");
    const multiStat = stat(multi, "avg");
    const multiPeak = stat(multi, "max");
    const whole = stat(cpuFreqSamples, "max");

    return {
      available: true,
      /** 单核阶段：只有一两个核在跑，峰值才是真实工作频率 */
      singlePeakMhz: singlePeak?.p95 ?? null,
      /** 全核阶段：所有核都满载，平均频率才有意义 */
      allCoreAvgMhz: multiStat?.avg ?? null,
      allCorePeakMhz: multiPeak?.p95 ?? null,
      /** 全程最高频（任何时刻任何核到达过的最大值） */
      maxMhz: whole?.max ?? null,
      samples: cpuFreqSamples.length,
      /** 内核报告的最高频率（cpuinfo_max_freq），代表硬件能力 */
      nominalMaxMhz: nominalMhz,
      // 全核平均值 ÷ 全程峰值 = 多核负载下能维持多少"实测峰值"，反映散热/功耗墙
      sustainedPct: multiStat?.avg && whole?.max ? Math.round((multiStat.avg / whole.max) * 1000) / 10 : null,
      /**
       * 睿频是否生效：实测峰值明显低于硬件标称最高频 → 睿频没上来。
       * 常见原因：BIOS 关闭 Turbo/Boost、功耗墙（PL1/PL2）设得低、温度墙、省电策略。
       * 这会让分数明显低于同款 CPU 的机器 —— 必须说出来，否则用户不知道自己"少跑了一截"。
       */
      boostLimited: Boolean(nominalMhz && whole?.max && whole.max < nominalMhz * 0.9),
    };
  })();
  // 睿频状态：**不能用"你比别人低"的口吻**。
  // 基准机本身就是在关闭睿频的状态下标定的（5825U 开 boost 发热太大），
  // 所以"关睿频"不是异常，只是这台机器的能效取向；真正需要说清楚的是
  // "榜上混着两种状态，跨状态不比"。实测值已经如实记录了频率，用户自己看得见。
  if (detail.cpuClock?.boostLimited) {
    caveats.push(
      `CPU 标称最高 ${detail.cpuClock.nominalMaxMhz} MHz，实测峰值 ${detail.cpuClock.maxMhz} MHz —— 睿频未启用（BIOS 关闭 Turbo、功耗墙或温度墙限制）。这是常见的静音/省电取向，不是故障；但开启睿频的机器在多核项目上会明显更高，跨状态比较时请留意。`,
    );
  }

  return {
    metrics,
    durations,
    caveats: [...new Set(caveats)],
    errors,
    detail,
    cancelled: Boolean(opts.shouldStop?.()),
    wallMs: Date.now() - t0,
  };
}
