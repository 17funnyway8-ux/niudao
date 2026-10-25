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

/** 随机访问：构建一条覆盖整块内存的随机环，走一圈测每次访问耗时 */
export function memLatency(sizeMb = 32, steps = 4_000_000) {
  const n = Math.floor((sizeMb * 1024 * 1024) / 4);
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
