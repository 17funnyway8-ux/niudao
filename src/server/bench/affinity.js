/**
 * 大小核（Intel P-core / E-core，ARM big.LITTLE）调度处理。
 *
 * 问题：单核测试如果被内核调度到 E 核上，分数会低 40–60%，而这个数字看起来
 * 像"这台机器很慢"，用户完全无从判断。Intel Core Ultra / 12 代以后的笔记本
 * 上尤其容易发生：CFS 在没有 ITMT 提示、或者容器/虚机里看不到拓扑时，
 * 单线程任务可能落在任意核上。
 *
 * 做法：
 *  1. 从 sysfs 识别 P 核 / E 核（Intel hybrid 驱动会给出 cpu_core / cpu_atom）；
 *  2. 单核测试**钉在 P 核**上跑（用 taskset 起子进程，Node 没有 sched_setaffinity）；
 *  3. 跑完把"钉在哪个核、是 P 还是 E"写进报告 —— 让分数可复现、可解释。
 *
 * 拿不到拓扑（非混合架构、或虚机里没暴露）时，一切照旧：不钉核，行为与之前一致。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PINNED_SCRIPT = path.join(HERE, "pinned-kernel.mjs");

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
};

/** "0-3,6" → [0,1,2,3,6] */
export function parseCpuList(spec) {
  const out = [];
  for (const part of String(spec || "").split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = a; i <= b; i += 1) out.push(i);
  }
  return out;
}

/**
 * 识别混合架构拓扑。
 * @returns {{hybrid: boolean, pCores: number[], eCores: number[], source: string}}
 */
export function detectHybrid() {
  // 1) Intel hybrid 驱动：/sys/devices/cpu_core/cpus 与 cpu_atom/cpus
  const p = read("/sys/devices/cpu_core/cpus");
  const e = read("/sys/devices/cpu_atom/cpus");
  if (p && e) {
    const pCores = parseCpuList(p);
    const eCores = parseCpuList(e);
    if (pCores.length && eCores.length) return { hybrid: true, pCores, eCores, source: "cpu_core/cpu_atom" };
  }

  // 2) 逐核 core_type（部分内核/平台只有这个）
  const total = os.cpus().length;
  const pCores = [];
  const eCores = [];
  for (let i = 0; i < total; i += 1) {
    const t = read(`/sys/devices/system/cpu/cpu${i}/topology/core_type`);
    if (t === null) continue;
    // Linux hybrid_cpu_type: 1 = Atom(E 核), 2 = Core(P 核)；不同内核版本表述不一，两种都兼容
    if (/^(1|atom)$/i.test(t)) eCores.push(i);
    else if (/^(2|core)$/i.test(t)) pCores.push(i);
  }
  if (pCores.length && eCores.length) return { hybrid: true, pCores, eCores, source: "topology/core_type" };

  return { hybrid: false, pCores: [], eCores: [], source: "" };
}

/** 挑一个 P 核：避开 cpu0（中断/软中断都压在上面），优先用最后一个 P 核 */
export function pickPCore(hybrid) {
  if (!hybrid?.hybrid || !hybrid.pCores?.length) return null;
  const candidates = hybrid.pCores.filter((c) => c !== 0);
  return (candidates.length ? candidates : hybrid.pCores).at(-1);
}

function hasTaskset() {
  for (const p of ["/usr/bin/taskset", "/bin/taskset"]) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

/**
 * 在指定核上跑一段 kernel，返回该核上测到的吞吐。
 * 用子进程是因为 Node 没有 sched_setaffinity；taskset 由 util-linux 提供，fnOS 自带。
 */
export function runPinnedKernel(durationMs, cpu, { timeoutMs = 120000 } = {}) {
  const taskset = hasTaskset();
  if (!taskset) return Promise.reject(new Error("没有 taskset，无法绑核"));
  return new Promise((resolve, reject) => {
    execFile(
      taskset,
      ["-c", String(cpu), process.execPath, PINNED_SCRIPT, String(durationMs)],
      { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const out = JSON.parse(String(stdout).trim().split("\n").pop());
          if (!Number.isFinite(out?.iters)) return reject(new Error("绑核子进程没有返回迭代数"));
          resolve(out);
        } catch (e) {
          reject(new Error(`绑核子进程输出无法解析：${e.message}`));
        }
      },
    );
  });
}

/** 供报告使用的能力描述 */
export function describeTopology(hybrid) {
  if (!hybrid?.hybrid) return { hybrid: false };
  return {
    hybrid: true,
    pCores: hybrid.pCores,
    eCores: hybrid.eCores,
    source: hybrid.source,
    label: `混合架构：${hybrid.pCores.length} 个性能核 + ${hybrid.eCores.length} 个能效核`,
  };
}
