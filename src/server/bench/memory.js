import fs from "node:fs";

/** 内存：memcpy 带宽 + 指针追逐延迟（NAS 上对应大文件搬运与元数据小请求） */
export function memBandwidth(bytesMb = 256, reps = 5) {
  const bytes = bytesMb * 1024 * 1024;
  const src = new Uint8Array(bytes);
  const dst = new Uint8Array(bytes);
  // 触摸一遍，触发物理页分配，避免把缺页时间算进成绩
  src[0] = 1;
  src[bytes - 1] = 1;
  dst[0] = 1;
  dst[bytes - 1] = 1;

  let best = 0;
  for (let i = 0; i < reps; i += 1) {
    const t0 = performance.now();
    dst.set(src);
    const dt = performance.now() - t0;
    const gbs = bytes / 1024 ** 3 / (dt / 1000);
    if (gbs > best) best = gbs;
  }
  const sum = dst[0] + dst[bytes - 1];
  return { gbs: Math.round(best * 100) / 100, detail: { bytesMb, reps, sink: sum } };
}

/**
 * 读取 CPU 的 L3 容量（MB）。多核共享，取 cpu0 的 index3 即可。
 *
 * 为什么必须读它：延迟测试原来用固定 32MB 的环，遇到 L3 ≥ 32MB 的 CPU
 * （AMD Strix Halo = 32MB、Xeon E5-2680 v4 = 35MB）整条环都装进缓存，
 * 测出来的是**缓存延迟**而非内存延迟。内测数据已实证：
 *   RYZEN AI MAX+ 395 报 11ns / 16ns，Xeon E5-2680 v4 报 20ns
 * 而真实内存延迟应在 100ns 左右 —— 这些机器因此被误判成"内存极快"。
 */
function l3SizeMb() {
  const read = (p) => {
    try {
      return fs.readFileSync(p, "utf8").trim();
    } catch {
      return "";
    }
  };
  const raw = read("/sys/devices/system/cpu/cpu0/cache/index3/size");
  const m = raw.match(/^(\d+)([KMG])/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "K") return n / 1024;
  if (unit === "M") return n;
  return n * 1024;
}

/**
 * 延迟测试的工作集大小：至少 2×L3（LRU 下才能基本全 miss），
 * 并限制在 32–96MB —— 环由 Int32Array 构建，内存占用约为 sizeMb 的 2 倍。
 */
export function pickLatencySizeMb() {
  const l3 = l3SizeMb();
  if (!l3 || !Number.isFinite(l3) || l3 <= 0) return 32;
  return Math.round(Math.max(32, Math.min(64, l3 * 2)));
}

export function l3Info() {
  const l3 = l3SizeMb();
  return { l3Mb: l3 ? Math.round(l3 * 10) / 10 : null, ringMb: pickLatencySizeMb() };
}

/** 随机访问：构建一条覆盖整块内存的随机环，走一圈测每次访问耗时 */
export function memLatency(sizeMbOrOpts = 32, stepsArg = 4_000_000) {
  // 兼容两种调用：memLatency(32) 与 memLatency({ sizeMb: 32 })。
  // 这里踩过一个坑：签名是位置参数，调用方传了对象 → sizeMb*1024*1024 = NaN
  // → new Int32Array(NaN) 得到空数组 → 循环瞬间跑完，测出 18ns 的假数据（还很快乐）
  const opts = typeof sizeMbOrOpts === "object" && sizeMbOrOpts !== null ? sizeMbOrOpts : { sizeMb: sizeMbOrOpts, steps: stepsArg };
  const sizeMb = Number(opts.sizeMb ?? 32);
  const steps = Number(opts.steps ?? 4_000_000);
  // 防御：工作集与步数必须是正数，否则直接报错，不要静默返回假数据
  if (!Number.isFinite(sizeMb) || sizeMb <= 0) throw new Error(`memLatency: sizeMb 非法（${opts.sizeMb}）`);
  if (!Number.isFinite(steps) || steps <= 0) throw new Error(`memLatency: steps 非法（${opts.steps}）`);
  const n = Math.floor((sizeMb * 1024 * 1024) / 4);
  if (n < 1024) throw new Error(`memLatency: 工作集过小（n=${n}）`);
  const next = new Int32Array(n);
  // Fisher-Yates 洗牌出随机置换环
  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  let seed = 0x9e3779b9;
  for (let i = n - 1; i > 0; i -= 1) {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 1) >>> 0;
    const j = seed % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  for (let i = 0; i < n - 1; i += 1) next[order[i]] = order[i + 1];
  next[order[n - 1]] = order[0];
  order.fill(0); // 大环（64MB）时两个数组共 128MB，用完即弃能少占一半

  let pos = 0;
  let acc = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i += 1) {
    pos = next[pos];
    acc += pos & 1;
  }
  const dt = performance.now() - t0;
  return { ns: Math.round((dt * 1e6) / steps), detail: { sizeMb, steps, sink: acc } };
}
