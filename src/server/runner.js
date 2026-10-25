/**
 * 套件编排：顺序执行各阶段，逐阶段上报进度，单阶段失败不拖垮整体。
 * 顺序刻意如此——先 CPU 后内存再磁盘，避免磁盘测试的缓存残留影响其它项。
 */
import { cpuMulti, cpuSingle, scalingEfficiency } from "./bench/cpu.js";
import { runBenchJob } from "./bench/offload.js";
import { diskRandom, diskSeq, prepareDir } from "./bench/disk.js";
import { startSampler } from "./bench/thermal.js";

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
  // 每秒采样：既给界面看实时温度，也攒下来算"测试期间 CPU 实际频率"
  const cpuFreqSamples = [];
  const sampler = startSampler((s) => {
    live({ temp: s });
    if (Number.isFinite(s?.freqMhz) && s.freqMhz > 0) cpuFreqSamples.push({ t: s.t, mhz: s.freqMhz });
  }, 1000);
  // 让 UI 在每个阶段开始时清掉上一阶段的实时数字（避免磁盘速率还挂在 CPU 阶段上）
  live({ stage: null });

  const step = async (index, fn) => {
    if (opts.shouldStop?.()) return null;
    const stage = STAGES[index];
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
    detail.disk_random = rand.detail;
    caveats.push(...(rand.caveats || []));
    return true;
  });

  sampler.stop();
  // 测试期间的工作频率 —— 同型号 CPU 开不开睿频，分数差得很多，
  // 不记录频率的话，看到"同一颗 CPU 差 30%"根本没法解释。
  detail.cpuClock = (() => {
    const freq = cpuFreqSamples.map((x) => x.mhz).filter((x) => x > 0);
    if (!freq.length) return { available: false, reason: "这台机器读不到 CPU 频率（缺 cpufreq 或权限）" };
    const sorted = [...freq].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    const avg = Math.round(freq.reduce((a, b) => a + b, 0) / freq.length);
    const max = Math.max(...freq);
    return {
      available: true,
      avgMhz: avg,
      maxMhz: max,
      p95Mhz: pct(95),
      minMhz: Math.min(...freq),
      samples: freq.length,
      // 峰值稳态比：越高说明越接近"全核满频"
      sustainedPct: max > 0 ? Math.round((avg / max) * 1000) / 10 : null,
    };
  })();
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
