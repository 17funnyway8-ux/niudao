/**
 * CPU 计算内核：整数哈希混合 + 一条浮点链 + 索引写回。
 * 为什么这么写：
 *  - 全整数 + Math.imul，避免不同 JIT 对浮点向量化的差异；
 *  - 循环体内有依赖链（a→b→c→d），不会被并行重排成"假快"；
 *  - 固定时限而非固定次数，跨机器公平。
 */
export const OPS_PER_ITER = 16;

export function kernelWork(durationMs) {
  const table = new Uint32Array(1024);
  for (let i = 0; i < 1024; i += 1) table[i] = (i * 2654435761) >>> 0;

  let a = 0x9e3779b9 >>> 0;
  let b = 0x85ebca6b >>> 0;
  let c = 0xc2b2ae35 >>> 0;
  let d = 0x27d4eb2f >>> 0;
  let fp = 1.0000001;

  const CHUNK = 20000;
  let iters = 0;
  const start = performance.now();
  const deadline = start + durationMs;
  let rounds = 0;

  while (performance.now() < deadline) {
    for (let i = 0; i < CHUNK; i += 1) {
      a = (a ^ (a << 13)) >>> 0;
      a = (a ^ (a >>> 17)) >>> 0;
      a = (a ^ (a << 5)) >>> 0;
      b = (b + a) >>> 0;
      c = Math.imul(c ^ b, 2654435761) >>> 0;
      d = (d + (c >>> 7)) >>> 0;
      fp = fp * 1.0000001 + (d & 1023) * 1e-12;
      if (fp > 1e6) fp = 1.0000001;
      const idx = d & 1023;
      table[idx] = (table[idx] + c) >>> 0;
    }
    iters += CHUNK;
    rounds += 1;
    if (rounds > 100000) break; // 保险丝
  }
  const elapsed = performance.now() - start;
  const sink = (a ^ b ^ c ^ d ^ table[0] ^ table[1023]) >>> 0;
  return { iters, elapsed, sink, mops: (iters * OPS_PER_ITER) / 1e6 / (elapsed / 1000) };
}

/** 预热：让 JIT 先编译热路径，避免把编译时间算进成绩 */
export function warmup(ms = 350) {
  kernelWork(ms);
}
