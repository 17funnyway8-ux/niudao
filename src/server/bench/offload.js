/**
 * 把同步基准丢到 worker 里跑，主线程继续服务 HTTP。
 * worker 自己崩了要让调用方知道（拿到的不是"0 分"，而是一个明确的失败）。
 */
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./compute-worker.js", import.meta.url));

/**
 * @param {"crypto"|"memory"} job
 * @param {number} timeoutMs 兜底超时，防止某项挂死把整个体检卡住
 */
export function runBenchJob(job, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { job } });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      w.terminate();
      reject(new Error(`${job} 基准超时（${timeoutMs}ms）`));
    }, timeoutMs);
    w.once("message", (m) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate();
      resolve(m);
    });
    w.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    w.once("exit", (code) => {
      if (settled || code === 0) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${job} worker 退出码 ${code}`));
    });
  });
}
