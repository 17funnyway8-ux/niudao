/**
 * 提交数据校验（应用端与排行榜服务端共用）。
 * 服务端不信任客户端算出来的分数：只收原始指标，分数一律服务端重算。
 */
import { METRIC_KEYS, SUITE_VERSION } from "./scoring.js";

/** 物理上可能的取值区间，用来挡住明显伪造/坏数据 */
export const PLAUSIBLE = {
  cpu_single: [1, 5000],
  cpu_multi: [1, 80000],
  crypto_aes: [1, 200000],
  zlib: [1, 20000],
  mem_copy: [0.05, 5000],
  mem_latency: [5, 50000],
  disk_seq_read: [0.5, 100000],
  disk_seq_write: [0.5, 100000],
  disk_rand_read: [1, 20000000],
  disk_rand_write: [1, 20000000],
};

const str = (v, max = 120) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

export function sanitizeAlias(raw) {
  const s = str(raw, 32).replace(/[<>"'`\\/]/g, "");
  return s.slice(0, 16);
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
  if (!["x64", "arm64", "ia32", "arm"].includes(arch)) errors.push(`arch 不支持: ${arch || "(空)"}`);

  const hw = input.hardware && typeof input.hardware === "object" ? input.hardware : {};
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
    volume: str(hw.volume, 64),
    disks: Array.isArray(hw.disks) ? hw.disks.slice(0, 24).map((d) => str(d, 64)).filter(Boolean) : [],
  };
  if (hardware.threads < 1) errors.push("hardware.threads 必须 >= 1");
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
      hardware,
      metrics,
      durations,
      caveats: Array.isArray(input.caveats) ? input.caveats.slice(0, 8).map((c) => str(c, 120)) : [],
      ts: Number.isFinite(input.ts) ? input.ts : Date.now(),
    },
  };
}

export { SUITE_VERSION };
