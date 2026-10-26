/**
 * 计算型子任务 worker：加密/压缩、内存读写都扔到这里跑。
 *
 * 为什么需要：这些基准是**同步**的（OpenSSL update、deflateSync、随机访存循环），
 * 在主线程跑就是 2–3 秒的服务停摆 —— 事件循环被锁，页面上的进度条定住，
 * 用户以为应用卡死了（实测 disk_seq 之前那段阻塞 3.7s，全是 crypto + memory 贡献的）。
 *
 * 关键点：测量的代码一行没改，只是换了条线程跑。所以基准分数与历史成绩完全可比，
 * 不需要重算 baselines、也不需要升套件版本。
 */
import { parentPort, workerData } from "node:worker_threads";
import { aesThroughput, zlibThroughput } from "./crypto.js";
import { memBandwidth, memLatency, pickLatencySizeMb } from "./memory.js";

const { job } = workerData;

let result;
if (job === "crypto") {
  result = { aes: aesThroughput(), zlib: zlibThroughput() };
} else if (job === "memory") {
  // 延迟环按本机 L3 定大小：固定 32MB 会在 L3 ≥ 32MB 的 CPU 上把内存延迟测成缓存延迟
  result = { bw: memBandwidth(), lat: memLatency({ sizeMb: pickLatencySizeMb() }) };
} else {
  throw new Error(`未知的基准任务: ${job}`);
}

parentPort.postMessage(result);
