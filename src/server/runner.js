/**
 * 套件编排：顺序执行各阶段，逐阶段上报进度，单阶段失败不拖垮整体。
 * 顺序刻意如此——先 CPU 后内存再磁盘，避免磁盘测试的缓存残留影响其它项。
 */
import { cpuMulti, cpuSingle, scalingEfficiency } from "./bench/cpu.js";
import { aesThroughput, zlibThroughput } from "./bench/crypto.js";
import { diskRandom, diskSeq, prepareDir } from "./bench/disk.js";
import { memBandwidth, memLatency } from "./bench/memory.js";

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

  const step = async (index, fn) => {
    if (opts.shouldStop?.()) return null;
    const stage = STAGES[index];
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
  }

  const multi = await step(1, () => cpuMulti(cfg.cpuMultiMs));
  if (multi) {
    metrics.cpu_multi = Math.round(multi.mops * 10) / 10;
    detail.cpu_multi = multi.detail;
    detail.scaling = scalingEfficiency(single?.mops, multi.mops, multi.detail.threads);
  }

  await step(2, () => {
    const aes = aesThroughput();
    const z = zlibThroughput();
    metrics.crypto_aes = aes.mbs;
    metrics.zlib = z.mbs;
    detail.crypto = { ...aes.detail, ...z.detail };
    return true;
  });

  await step(3, () => {
    const bw = memBandwidth();
    const lat = memLatency();
    metrics.mem_copy = bw.gbs;
    metrics.mem_latency = lat.ns;
    detail.memory = { ...bw.detail, ...lat.detail };
    return true;
  });

  await step(4, () => {
    const seq = diskSeq(targetDir, { sizeMb: cfg.diskSizeMb });
    metrics.disk_seq_read = seq.read_mbs;
    metrics.disk_seq_write = seq.write_mbs;
    detail.disk_seq = seq.detail;
    caveats.push(...(seq.caveats || []));
    return true;
  });

  await step(5, () => {
    const rand = diskRandom(targetDir, { fileMb: cfg.diskFileMb, seconds: cfg.diskSeconds });
    if (rand.read_iops) metrics.disk_rand_read = rand.read_iops;
    if (rand.write_iops) metrics.disk_rand_write = rand.write_iops;
    detail.disk_random = rand.detail;
    caveats.push(...(rand.caveats || []));
    return true;
  });

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
