/**
 * 绑核跑一次 kernel，把结果打到 stdout（JSON 单行）。
 * 由 affinity.js 用 `taskset -c <cpu> node pinned-kernel.mjs <ms>` 启动。
 *
 * 单独一个文件而不是 worker：Node 的 worker_threads 没有 CPU 亲和性接口，
 * 想让某段计算固定落在某个核上，只能靠进程级 taskset。
 */
import { kernelWork, warmup, OPS_PER_ITER } from "./kernel.js";

const durationMs = Number(process.argv[2]) || 5000;

warmup(350);
const r = kernelWork(durationMs);

process.stdout.write(
  `${JSON.stringify({
    iters: r.iters,
    elapsed: r.elapsed,
    sink: r.sink,
    mops: (r.iters * OPS_PER_ITER) / 1e6 / (r.elapsed / 1000),
  })}\n`,
);
