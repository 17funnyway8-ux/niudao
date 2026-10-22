/** 多核 worker：每个线程跑同一份 kernel，回报自己完成的迭代数 */
import { parentPort, workerData } from "node:worker_threads";
import { kernelWork } from "./kernel.js";

const { durationMs } = workerData;
const r = kernelWork(durationMs);
parentPort.postMessage({ iters: r.iters, elapsed: r.elapsed, sink: r.sink });
