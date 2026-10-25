/**
 * 提交数据校验（应用端与排行榜服务端共用）。
 * 服务端不信任客户端算出来的分数：只收原始指标，分数一律服务端重算。
 */
import { METRIC_KEYS, SUITE_VERSION } from "./scoring.js";

/** 物理上可能的取值区间，用来挡住明显伪造/坏数据 */
/**
 * 原始值的可信区间（第一道闸，挡住明显错误的输入；分数封顶是第二道）。
 *
 * 原则和 SCORE_CAP 一致：**算力给足，I/O 按物理收紧**。
 *  - CPU 多核上限从 80000 放宽到 500000：双路 128 核 EPYC 大约 46 万，不能被判为异常
 *  - 磁盘顺序上限从 100000 收到 30000：PCIe 5.0 单盘 ~14 GB/s，家用多盘阵列也难过 30 GB/s，
 *    超过这个数基本是虚机把写吞进了内存
 */
export const PLAUSIBLE = {
  cpu_single: [1, 8000],
  cpu_multi: [1, 500000],
  crypto_aes: [1, 300000],
  zlib: [1, 20000],
  mem_copy: [0.05, 5000],
  mem_latency: [5, 50000],
  disk_seq_read: [0.5, 30000],
  disk_seq_write: [0.5, 30000],
  disk_rand_read: [1, 200000],
  disk_rand_write: [1, 200000],
};

const str = (v, max = 120) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

/** 通用文本清洗：去掉控制字符、双向/零宽字符、HTML 敏感字符，再按字符数截断 */
export function cleanText(raw, max = 120) {
  const s = str(raw, max * 2)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>"'`\\/]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .trim();
  return Array.from(s).slice(0, max).join("");
}

export function sanitizeAlias(raw) {
  // 1) 去掉 ASCII 控制字符（尤其是 \r \n：别名会被写进 JSONL/日志，换行能伪造出假记录）
  // 2) 去掉 HTML/脚本敏感字符
  // 3) 去掉双向控制符与零宽字符：U+202E 之类能把显示顺序反转，冒充别人或藏字符
  const s = str(raw, 32)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>"'`\\/]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .trim();
  return Array.from(s).slice(0, 16).join("");
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @returns {{ok: boolean, errors: string[], value: object|null}}
 */
export function validateSubmission(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["body 必须是 JSON 对象"], value: null };

  const suite = str(input.suite, 20);
  if (!/^\d+\.\d+\.\d+$/.test(suite)) errors.push("suite 必须是 x.y.z 形式的套件版本");

  const client = str(input.client, 20) || "unknown";
  const fingerprint = str(input.fingerprint, 64);
  if (!/^[a-f0-9]{8,64}$/i.test(fingerprint)) errors.push("fingerprint 必须是 8-64 位十六进制");

  const arch = str(input.arch, 20);
  // 运行环境：physical / vm / container。客户端自报，服务端下面还会复核
  const rawEnv = str(input.env_type, 16).toLowerCase();
  const envType = ["physical", "vm", "container"].includes(rawEnv) ? rawEnv : "physical";
  const vmTech = cleanText(input.vm_tech, 40);
  // 客户端上报的判定证据（服务端用来交叉验证，尤其在 board 读不到时）
  const hypervisorFlag = input.hypervisor === true;
  const envEvidence = Array.isArray(input.env_evidence)
    ? input.env_evidence.slice(0, 6).map((e) => cleanText(e, 80)).filter(Boolean)
    : [];
  if (!["x64", "arm64", "ia32", "arm"].includes(arch)) errors.push(`arch 不支持: ${arch || "(空)"}`);

  // hardware 里的自由文本会原样出现在公开榜单上，和别名走同一套清洗规则
  const rawHw = input.hardware && typeof input.hardware === "object" ? input.hardware : {};
  const hw = {
    ...rawHw,
    cpu_model: cleanText(rawHw.cpu_model, 120),
    board: cleanText(rawHw.board, 120),
    gpu: cleanText(rawHw.gpu, 120),
    os_version: cleanText(rawHw.os_version, 32),
    kernel: cleanText(rawHw.kernel, 64),
  };
  const hardware = {
    cpu_model: str(hw.cpu_model, 96) || "Unknown CPU",
    cores: num(hw.cores) ?? 0,
    threads: num(hw.threads) ?? 0,
    mem_gb: Math.round(num(hw.mem_gb) ?? 0),
    mem_gib: Number.isFinite(num(hw.mem_gib)) ? Math.round(num(hw.mem_gib) * 10) / 10 : null,
    os_version: str(hw.os_version, 40),
    kernel: str(hw.kernel, 60),
    board: str(hw.board, 96),
    gpu: str(hw.gpu, 96),
    // 注意：volume / disks 是**客户端本地算分用的**，不进提交体。
    // 之前这里还会从 input 里收，结果榜单接口把用户的卷路径与磁盘布局原样
    // 露出了（已修）。服务端不需要它们：分数是拿 metrics 重算的。
  };
  if (hardware.threads < 1) errors.push("hardware.threads 必须 >= 1");

  // 依赖注入的复核函数（scoring 不引 hardware，避免循环依赖，由调用方传入判定）
  const envOverride =
    typeof input.__envOverride === "function"
      ? input.__envOverride({ ...hardware, hypervisorFlag, osVersion: hardware.os_version })
      : null;
  const finalEnv = envOverride || envType;
  if (hardware.mem_gb < 1) errors.push("hardware.mem_gb 必须 >= 1");

  const raw = input.metrics && typeof input.metrics === "object" ? input.metrics : {};
  const metrics = {};
  for (const key of METRIC_KEYS) {
    const v = num(raw[key]);
    if (v === null) continue;
    const [lo, hi] = PLAUSIBLE[key];
    if (v < lo || v > hi) {
      errors.push(`${key}=${v} 超出可信区间 [${lo}, ${hi}]`);
      continue;
    }
    metrics[key] = Math.round(v * 1000) / 1000;
  }
  if (Object.keys(metrics).length < 4) errors.push("有效指标少于 4 项，拒绝入库");

  const durations = input.durations && typeof input.durations === "object" ? input.durations : {};

  if (errors.length) return { ok: false, errors, value: null };

  return {
    ok: true,
    errors: [],
    value: {
      suite,
      client,
      fingerprint,
      arch,
      alias: sanitizeAlias(input.alias),
      envType: finalEnv,
      vmTech: envOverride ? "由服务端识别" : vmTech,
      hardware,
      metrics,
      durations,
      caveats: Array.isArray(input.caveats) ? input.caveats.slice(0, 8).map((c) => str(c, 120)) : [],
      ts: Number.isFinite(input.ts) ? input.ts : Date.now(),
    },
  };
}

export { SUITE_VERSION };
