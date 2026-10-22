/**
 * 持续负载（烤机）。用来观察"满载 10 分钟后还剩多少性能"，而不是跑一个固定时长的分。
 *  - CPU：每个逻辑核一个 worker，跑同一份内核；
 *  - 磁盘（可选）：反复 O_DIRECT 顺序写，模拟 RAID 重建/大量写入时的机箱温度。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./burn-worker.js", import.meta.url));

function threadCount() {
  try {
    return os.availableParallelism();
  } catch {
    return os.cpus().length;
  }
}

/**
 * @param {{threads?: number, chunkMs?: number, onProgress?: (p:{iters:number,threads:number})=>void}} cfg
 */
export function startBurn({ threads = threadCount(), chunkMs = 500, onProgress } = {}) {
  const workers = [];
  let iters = 0;
  let finished = 0;
  const startedAt = Date.now();
  const dones = [];

  for (let i = 0; i < threads; i += 1) {
    const w = new Worker(WORKER, { workerData: { chunkMs } });
    const done = new Promise((resolve) => {
      w.on("message", (msg) => {
        if (msg.type === "chunk") {
          iters += msg.iters;
          onProgress?.({ iters, threads });
        } else if (msg.type === "done") {
          iters += msg.iters;
          finished += 1;
          resolve();
        }
      });
      w.on("error", () => resolve());
      w.on("exit", () => resolve());
    });
    dones.push(done);
    workers.push(w);
  }

  return {
    threads,
    /** 停止并返回本次负载的总迭代数 */
    async stop() {
      for (const w of workers) {
        try {
          w.postMessage("stop");
        } catch {
          /* 已退出 */
        }
      }
      const timeout = new Promise((r) => setTimeout(r, 4000));
      await Promise.race([Promise.all(dones), timeout]);
      for (const w of workers) {
        try {
          await w.terminate();
        } catch {
          /* ignore */
        }
      }
      return { iters, threads, wallMs: Date.now() - startedAt, finished };
    },
  };
}

/**
 * 可选：磁盘持续写。默认关闭（会消耗 SSD 寿命，也会让 HDD 一直响）。
 * @param {string} dir
 * @param {{sizeMb?: number}} cfg
 */
export function startDiskChurn(dir, { sizeMb = 256 } = {}) {
  const file = path.join(dir, ".niudao-burn.bin");
  let stopped = false;
  let child = null;
  let cycles = 0;

  const runOnce = () => {
    if (stopped) return;
    child = spawn(
      "dd",
      ["if=/dev/zero", `of=${file}`, "bs=1M", `count=${sizeMb}`, "oflag=direct", "conv=fdatasync", "status=none"],
      { stdio: "ignore" },
    );
    child.on("exit", () => {
      if (stopped) return;
      cycles += 1;
      runOnce();
    });
  };
  runOnce();

  return {
    async stop() {
      stopped = true;
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      fs.rmSync(file, { force: true });
      return { cycles, sizeMb };
    },
  };
}
