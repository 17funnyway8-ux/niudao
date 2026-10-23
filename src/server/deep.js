/**
 * 深度档：先在冷态跑一次多核分，再满载烤机 durationSec，再跑一次多核分，
 * 用"前后性能保持率 + 温度曲线 + 频率变化"判断这台机器的持续性能。
 */
import { cpuMulti } from "./bench/cpu.js";
import { startBurn, startDiskChurn } from "./bench/burn.js";
import { prepareDir } from "./bench/disk.js";
import { startSampler } from "./bench/thermal.js";
import { OPS_PER_ITER } from "./bench/kernel.js";
import { analyzeStability, downsample } from "../shared/stability.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 多核吞吐测多次取最好值。
 * 为什么不用单次：多核跑分对外部干扰极敏感（实测同一台机器连续 5 次能差 7%），
 * 单次对比会把噪声误判成"降频"。取最好值相当于挑最干净的一次，可复现性明显更好。
 */
async function measureMultiBest({ rounds = 3, ms = 4000 } = {}) {
  const vals = [];
  for (let i = 0; i < rounds; i += 1) {
    try {
      const r = await cpuMulti(ms);
      vals.push(r.mops);
    } catch {
      /* 单轮失败不影响其它轮 */
    }
  }
  if (!vals.length) return null;
  return { mops: Math.max(...vals), rounds: vals.length, all: vals.map((v) => Math.round(v)) };
}

export const DEEP_LIMITS = {
  minSec: Number(process.env.NIUDAO_DEEP_MIN_SEC) || 60,
  maxSec: 3600,
  defaultSec: 600,
};

export function normalizeDuration(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEEP_LIMITS.defaultSec;
  return Math.max(DEEP_LIMITS.minSec, Math.min(DEEP_LIMITS.maxSec, Math.round(n)));
}

/**
 * @param {object} cfg
 * @param {string} cfg.targetDir 磁盘压力测试落盘目录（loadDisk=true 时才用）
 * @param {number} cfg.durationSec 烤机时长
 * @param {boolean} cfg.loadDisk 是否叠加磁盘写压力
 * @param {number} [cfg.roundMs] 每轮多核测量时长（默认 4s）
 * @param {number} [cfg.rounds] 前后各测几轮取最好（默认 3）
 * @param {(ev:object)=>void} cfg.onEvent 进度事件
 * @param {()=>boolean} cfg.shouldStop 中止检查
 */
export async function runDeep({
  targetDir,
  durationSec = DEEP_LIMITS.defaultSec,
  loadDisk = false,
  roundMs = 4000,
  rounds = 3,
  onEvent = () => {},
  shouldStop = () => false,
}) {
  // 时长校验放在 HTTP 层（normalizeDuration）；这里信任调用方，便于测试用极短时长
  const duration = Math.max(1, Math.round(Number(durationSec) || DEEP_LIMITS.defaultSec));
  const startedAt = Date.now();
  const series = [];
  const notes = [];
  const emit = (ev) => {
    try {
      onEvent({ ...ev, elapsedMs: Date.now() - startedAt });
    } catch {
      /* 忽略上报异常 */
    }
  };

  prepareDir(targetDir);

  // ---- 1) 冷态基线 ----
  emit({ type: "phase", phase: "baseline", label: "冷态基线（多核多轮取最好）" });
  let preMops = null;
  let preRounds = null;
  try {
    const pre = await measureMultiBest({ rounds, ms: roundMs });
    if (pre) {
      preMops = pre.mops;
      preRounds = pre.all;
      emit({ type: "baseline", mops: Math.round(pre.mops), rounds: pre.all });
    }
  } catch (e) {
    notes.push(`冷态基线失败：${e?.message || e}`);
  }

  if (shouldStop()) {
    return { cancelled: true, stability: analyzeStability({ series, preMops, postMops: null, durationSec: 0 }), series: [], wallMs: Date.now() - startedAt };
  }

  // ---- 2) 采样 + 烤机 ----
  const sampler = startSampler((s) => {
    series.push(s);
    emit({ type: "sample", sample: s });
  }, 1000);
  const capabilities = sampler.capabilities();

  emit({ type: "phase", phase: "burn", label: `满载烤机 ${duration < 90 ? `${duration} 秒` : `${Math.round(duration / 60)} 分钟`}`, durationSec: duration, loadDisk });

  // 逐轮吞吐：每 probeSec 记录一次累计迭代数，delta 即该轮的实际算力。
  // 这就是 3DMark 压力测试里"每一 loop 的平均帧率"，用来算稳定性 = 最差轮/最好轮。
  const probeSec = Math.max(5, Math.min(30, Math.round(duration / 12)));
  // 预热窗口：worker 启动 + JIT 编译 + 风扇提速都在前十几秒，这段时间的吞吐不代表稳态，
  // 直接算进稳定性会得出"散热吃紧"的假结论。跳过它再开始记轮次。
  const warmupSec = Math.min(30, Math.max(8, Math.round(duration * 0.15)));
  const roundsSeries = [];
  let lastProbe = null;
  const burnStart = Date.now();

  const burn = startBurn({
    chunkMs: 500,
    onProgress: ({ iters }) => {
      const now = (Date.now() - burnStart) / 1000;
      if (now < warmupSec) return;
      if (!lastProbe) {
        lastProbe = { t: now, iters }; // 预热结束，把当前累计值当基准
        return;
      }
      const dt = now - lastProbe.t;
      if (dt < probeSec) return;
      const dmops = ((iters - lastProbe.iters) * OPS_PER_ITER) / 1e6 / dt;
      if (dmops > 0) roundsSeries.push({ t: Math.round(now), mops: Math.round(dmops * 10) / 10 });
      lastProbe = { t: now, iters };
    },
  });
  const churn = loadDisk ? startDiskChurn(targetDir, { sizeMb: 256 }) : null;
  let lastTick = 0;
  while (!shouldStop() && (Date.now() - burnStart) / 1000 < duration) {
    await sleep(500);
    const elapsed = (Date.now() - burnStart) / 1000;
    if (elapsed - lastTick >= 5) {
      lastTick = elapsed;
      const last = series[series.length - 1] || {};
      const lastRound = roundsSeries[roundsSeries.length - 1];
      emit({
        type: "tick",
        burnedSec: Math.round(elapsed),
        remainingSec: Math.max(0, Math.round(duration - elapsed)),
        mops: lastRound?.mops ?? null,
        sample: { t: Math.round(elapsed), cpuC: last.cpuC ?? null, freqMhz: last.freqMhz ?? null, fanRpm: last.fanRpm ?? null },
      });
    }
  }

  const cancelled = shouldStop();
  const burnResult = await burn.stop();
  const churnResult = churn ? await churn.stop() : null;
  sampler.stop();
  const burnedSec = Math.round((Date.now() - burnStart) / 1000);

  // ---- 3) 热态复测 ----
  let postMops = null;
  let postRounds = null;
  if (!cancelled) {
    emit({ type: "phase", phase: "post", label: "热态复测（多核多轮取最好）" });
    try {
      const post = await measureMultiBest({ rounds, ms: roundMs });
      if (post) {
        postMops = post.mops;
        postRounds = post.all;
        emit({ type: "post", mops: Math.round(post.mops), rounds: post.all });
      }
    } catch (e) {
      notes.push(`热态复测失败：${e?.message || e}`);
    }
  }

  const maxFreq = capabilities.maxFreqMhz;
  const stability = analyzeStability({
    warmupSec,
    series,
    rounds: roundsSeries,
    preMops,
    postMops: cancelled ? null : postMops,
    durationSec: burnedSec,
    nominalMhz: maxFreq,
  });
  stability.notes = [...stability.notes, ...notes];
  stability.capabilities = { ...stability.capabilities, ...capabilities };
  stability.load = { cpuThreads: burnResult.threads, diskChurn: Boolean(churn), diskCycles: churnResult?.cycles ?? 0 };
  stability.cancelled = cancelled;
  stability.probeSec = probeSec;
  stability.warmupSec = warmupSec;
  if (stability.boost) {
    stability.boost.coldRounds = preRounds;
    stability.boost.hotRounds = postRounds;
    // 多轮之间的离散度：太大说明机器上有别的负载在抢 CPU，结论只能参考
    const spread = (arr) => (arr && arr.length > 1 ? ((Math.max(...arr) - Math.min(...arr)) / Math.max(...arr)) * 100 : 0);
    const sp = spread(preRounds);
    const sq = spread(postRounds);
    if (Math.max(sp, sq) > 5) {
      stability.notes.push(
        `同一侧多轮测量波动较大（冷态 ${sp.toFixed(1)}%、热态 ${sq.toFixed(1)}%）：机器上可能有别的负载在跑，这次的结论仅供参考。`,
      );
    }
  }

  const compact = downsample(
    series.map((s) => ({ t: s.t, cpuC: s.cpuC, freqMhz: s.freqMhz, fanRpm: s.fanRpm, nvmeC: s.nvmeC })),
    240,
  );

  emit({ type: "phase", phase: "done", label: "分析完成", verdict: stability.verdict });

  return { cancelled, stability, series: compact, rounds: roundsSeries, preMops, postMops, burnedSec, wallMs: Date.now() - startedAt };
}
