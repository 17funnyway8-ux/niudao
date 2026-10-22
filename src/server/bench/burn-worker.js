/** 烤机 worker：持续跑 CPU 内核直到收到 stop。分块执行是为了能及时响应停止指令。 */
import { parentPort, workerData } from "node:worker_threads";
import { kernelWork } from "./kernel.js";

const chunkMs = workerData?.chunkMs ?? 500;
let total = 0;
let stopped = false;

parentPort.on("message", (msg) => {
  if (msg === "stop") stopped = true;
});

function loop() {
  if (stopped) {
    parentPort.postMessage({ type: "done", iters: total });
    return;
  }
  const r = kernelWork(chunkMs);
  total += r.iters;
  parentPort.postMessage({ type: "chunk", iters: r.iters, elapsed: r.elapsed });
  setImmediate(loop);
}

loop();
