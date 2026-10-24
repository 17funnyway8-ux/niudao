/**
 * CPU：单核 / 多核，两者都跑在 worker_threads 里。
 * 单核曾经在主线程跑 —— 那会让整个 http 服务冻住两轮共 ~10 秒，
 * 用户看到的就是"点了开始体检，页面卡死"。计算放 worker，主线程继续服务进度轮询。
 * 实测两种跑法差异 -0.2%（噪声级），所以基准不需要重算。
 */
import os from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { OPS_PER_ITER } from "./kernel.js";

const WORKER = fileURLToPath(new URL("./worker.js", import.meta.url));

/** 单核：跑两轮取好的一轮，抵消偶发调度抖动（全部在 worker 里完成） */
export async function cpuSingle(durationMs = 6000) {
  const r = await runWorker(durationMs, { rounds: 2, warmupMs: 350 });
  const mops = (r.iters * OPS_PER_ITER) / 1e6 / (r.elapsed / 1000);
  return { mops, detail: { rounds: 2, opsPerIter: OPS_PER_ITER, inWorker: true, iters: r.allIters } };
}

function runWorker(durationMs, extra = {}) {
  return new Promise((resolve, reject) => {
    const { onMessage, ...workerData } = extra;
    const w = new Worker(WORKER, { workerData: { durationMs, ...workerData } });
    let settled = false;
    w.on("message", (m) => {
      if (m?.type === "progress") {
        onMessage?.(m);
        return;
      }
      if (settled) return;
      settled = true;
      resolve(m);
      w.terminate();
    });
    w.once("error", (e) => {
      if (!settled) reject(e);
    });
    w.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`worker 退出码 ${code}`));
    });
  });
}

export async function cpuMulti(durationMs = 6000, { onProgress } = {}) {
  const threads = (() => {
    try {
      return os.availableParallelism();
    } catch {
      return os.cpus().length;
    }
  })();
  const started = performance.now();
  // 每秒汇总各线程的吞吐快照，送给 UI 显示实时数字
  const latest = new Map();
  const totalMops = () => [...latest.values()].reduce((sum, m) => sum + m, 0);
  const results = await Promise.all(
    Array.from({ length: threads }, (_, i) =>
      runWorker(durationMs, {
        onMessage: (m) => {
          if (m?.type !== "progress") return;
          latest.set(i, m.mops || 0);
          try {
            onProgress?.({ mops: Math.round(totalMops()), elapsed: m.elapsed });
          } catch {
            /* 回调异常不影响测试 */
          }
        },
      }),
    ),
  );
  const wall = (performance.now() - started) / 1000;
  const iters = results.reduce((s, r) => s + (r.iters || 0), 0);
  const mops = (iters * OPS_PER_ITER) / 1e6 / wall;
  return { mops, detail: { threads, wall: Math.round(wall * 100) / 100, perThread: results.map((r) => Math.round(r.iters)) } };
}

/** 扩展效率：多核吞吐 /（单核 × 线程数）。1.0 表示完美线性 */
export function scalingEfficiency(singleMops, multiMops, threads) {
  if (!singleMops || !multiMops || !threads) return null;
  return Math.round((multiMops / (singleMops * threads)) * 1000) / 10;
}
