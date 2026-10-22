/** CPU：单核 / 多核。多核用 worker_threads，各线程各自计时，汇总吞吐。 */
import os from "node:os";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { kernelWork, warmup, OPS_PER_ITER } from "./kernel.js";

const WORKER = fileURLToPath(new URL("./worker.js", import.meta.url));

export function cpuSingle(durationMs = 6000) {
  warmup();
  const best = [];
  // 跑两轮取好的一轮：抵消偶发调度抖动
  for (let i = 0; i < 2; i += 1) {
    const r = kernelWork(durationMs);
    best.push(r.mops);
  }
  const mops = Math.max(...best);
  return { mops, detail: { rounds: 2, opsPerIter: OPS_PER_ITER } };
}

function runWorker(durationMs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { durationMs } });
    let settled = false;
    w.once("message", (m) => {
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

export async function cpuMulti(durationMs = 6000) {
  const threads = (() => {
    try {
      return os.availableParallelism();
    } catch {
      return os.cpus().length;
    }
  })();
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: threads }, () => runWorker(durationMs)));
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
