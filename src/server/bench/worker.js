/**
 * worker：每个线程跑同一份 kernel，回报自己完成的迭代数。
 *
 * 为什么要支持多轮：单核测试要"跑两轮取好的一轮"来抵消偶发调度抖动，
 * 而单核如果放在主线程跑，会**把整个 http 服务冻住 10 秒**（页面上的进度条直接停住）。
 * 所以单核也挪进 worker，多轮在这里面跑完，主线程只等一个消息。
 */
import { parentPort, workerData } from "node:worker_threads";
import { kernelWork, warmup } from "./kernel.js";

const { durationMs, rounds = 1, warmupMs = 0 } = workerData;

// 预热只给单核路径用：多核要是每个线程都先预热 350ms，墙钟会被拉长，口径就变了
if (warmupMs > 0) warmup(warmupMs);

const results = [];
for (let i = 0; i < rounds; i += 1) results.push(kernelWork(durationMs));

const best = results.reduce((a, b) => (b.iters / b.elapsed > a.iters / a.elapsed ? b : a));

parentPort.postMessage({
  iters: best.iters,
  elapsed: best.elapsed,
  sink: best.sink,
  rounds,
  allIters: results.map((r) => r.iters),
});
