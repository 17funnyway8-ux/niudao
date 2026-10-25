/**
 * 内存：大块传输带宽 + 随机访问延迟。
 *
 * 调研参考（AIDA64 Cache & Memory Benchmark / Arm ASCT latency-sweep）：
 *  · AIDA64 的带宽测试用 **8 MB、1 MB 对齐** 缓冲区，走 SSE/AVX 单线程前向复制；
 *    8 MB 贴近主流 L3 边界，所以它测到的是"接近理论峰值"的带宽（DDR5 能报 70+ GB/s）。
 *  · AIDA64 的延迟用 **pointer chase**（随机链表，每次加载依赖上一次结果），
 *    以此破坏硬件预取与乱序执行，测的是"真实往返延迟"。
 *  · ASCT 更进一层：用 **1 GiB hugepage** 分配工作集，把页表遍历（TLB miss）
 *    的干扰压到最低，并扫多个容量画成 latency-vs-size 曲线，自动识别各级缓存边界。
 *
 * 我们为什么不照抄 8 MB：
 *   NAS 的真实负载是大文件搬运（SMB 传电影、备份），块大小远超 L3。
 *   8 MB 测出来的是"缓存 + 内存混合"的乐观值，对 NAS 用户没有指导意义。
 *   所以我们用远大于 L3 的缓冲区，测的是**真实的、越过缓存的主存带宽**，
 *   代价是数值会比 AIDA64 小得多（那是口径差异，不是性能差异）。
 *
 * JS 运行时的硬限制（实测得出，别在这上面白费力气）：
 *   · read 带宽测不了 —— 手写循环读 Uint32 只有 1–2 GB/s，瓶颈在 JS 循环而非内存。
 *   · copy（TypedArray.set → memcpy）与 write（fill → memset）走的是原生实现，可信。
 *   所以带宽只用 copy 一项进评分，write 作为报告里的旁证。
 */

const MB = 1024 * 1024;

/**
 * 缓冲区大小：按机器内存动态定档。
 * 原来固定 256 MB（两个缓冲区共 512 MB），在 4 GB 的 ARM 小主机上会挤到 swap，
 * 测出来的低分是"被我们的测试压垮"，不是硬件差。
 */
export function pickBufferMb(totalMemGb = 8) {
  if (totalMemGb <= 2) return 32;
  if (totalMemGb <= 4) return 64;
  return 256;
}

/**
 * 大块传输带宽（memcpy）。
 *
 * 关键：**必须完整预热**。原实现只碰首尾各 1 字节，Linux 的延迟分配
 * （overcommit）因此只为 2 个页分配物理内存，第一次 memcpy 要触发几万次缺页，
 * 全被算进带宽 —— 实测第一次只有 1.08 GB/s，后续 17 GB/s，差 16 倍。
 *
 * 采样策略改为**取中位数**：多次实测显示完整预热后波动仅 5%，
 * 而"取最好"会把偶发的乐观值（透明大页恰好给的连续物理页）当成常态，
 * 实测能比中位数高 89%（17.46 vs 9.25 GB/s）。
 */
export function memBandwidth({ bufferMb = 256, rounds = 9 } = {}) {
  const bytes = bufferMb * MB;
  const src = new Uint8Array(bytes);
  const dst = new Uint8Array(bytes);

  // 预热：走**一次完整的 memcpy**（不计时），把缺页与 TLB 填热。
  //
  // ⚠️ 这里踩过一个坑：最早我改成 src.fill(1) + dst.fill(0) 全页预处理，
  // 结果带宽从 17 掉到 8.8 —— 因为本机透明大页是 [always]，大量 memset 会让
  // 内核拆分 2MB 大页、退化成 4KB 页，TLB 覆盖变差，测出来的低值是"被测试方法
  // 自己搞坏的"，不是内存的问题。实测对照：
  //   只碰首尾、含首测      → 首测 1.12（缺页），稳态 16.8
  //   fill 全页预热         → 稳定 8.8（大页被拆）
  //   预热一次 memcpy       → 稳定 17.07 ✅ 既没有缺页污染，也没破坏大页
  src[0] = 1;
  src[bytes - 1] = 1;
  dst[0] = 1;
  dst[bytes - 1] = 1;
  dst.set(src);

  const samples = [];
  for (let i = 0; i < rounds; i += 1) {
    const t0 = performance.now();
    dst.set(src);
    const dt = performance.now() - t0;
    if (dt > 0) samples.push((bytes / 1024 ** 3 / dt) * 1000);
  }
  if (!samples.length) return { gbs: 0, detail: { bufferMb, rounds: 0 } };

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const best = sorted[sorted.length - 1];
  const worst = sorted[0];
  // 消费一下缓冲区，避免 JIT 把整段优化掉
  const sink = dst[0] + dst[bytes - 1] + src[0];

  return {
    gbs: Math.round(median * 100) / 100,
    detail: {
      bufferMb,
      rounds: samples.length,
      medianGbs: Math.round(median * 100) / 100,
      bestGbs: Math.round(best * 100) / 100,
      worstGbs: Math.round(worst * 100) / 100,
      spreadPct: best > 0 ? Math.round(((best - worst) / best) * 1000) / 10 : null,
      sink,
    },
  };
}

/**
 * 单点随机访问延迟（pointer chase）：构建随机置换环，走一遍测每次访问耗时。
 *
 * 工作集必须显著大于 L3，否则测到的是缓存而不是内存。
 * 环用 Int32Array 存下标，节点之间随机相连，硬件预取完全猜不到下一个地址。
 */
export function memLatency({ sizeMb = 64, steps = 2_000_000 } = {}) {
  const n = Math.floor((sizeMb * MB) / 4);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  // Fisher-Yates，xorshift 做随机源（不依赖 Math.random，可复现）
  let seed = 0x9e3779b9;
  for (let i = n - 1; i > 0; i -= 1) {
    seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 1) >>> 0;
    const j = seed % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const next = new Int32Array(n);
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
  return {
    ns: Math.round((dt * 1e6) / steps),
    detail: { sizeMb, steps, sink: acc },
  };
}

/**
 * 延迟扫描（借鉴 ASCT 的 latency-sweep）。
 *
 * 单一数字说明不了什么：同一个 108ns，可能是"L3 命中一半"也可能是"主存但 TLB 友好"。
 * 扫几个工作集就能看出台阶 —— 台阶位置就是 L2/L3 的容量边界，
 * 越过大台阶之后的那个值才是真正的"访问主存"延迟。
 *
 * 实测本机（5825U，L3=16MB，睿频关闭）：
 *   0.25MB →   8ns   L2 命中
 *      1MB →  20ns   L2 边界
 *      4MB →  27ns   L3 内
 *     16MB →  98ns   越过 L3（台阶在这里）
 *     64MB → 145ns   纯主存 + 页表开销
 *
 * 注意 145ns 高于 DDR4-3200 的理论延迟（约 80ns）：多出来的是 TLB miss 引起的
 * 页表遍历。ASCT 用 hugepage 消除这部分，Node 没有相应 API 做不到。
 * 保留它是合理的 —— NAS 的真实小文件随机访问同样要付这个代价，
 * 只是报告里必须说明它"含页表开销"，不能标成裸的内存延迟。
 */
export function memLatencySweep({
  // 32MB 这一档沿用旧实现的 4M 步（口径必须一致才能跨版本比），
  // 其余档位只是给报告画曲线用，步数少一点省时间。
  points = [
    { sizeMb: 4, steps: 1_200_000 },
    { sizeMb: 16, steps: 1_200_000 },
    { sizeMb: 32, steps: 4_000_000 },
    { sizeMb: 64, steps: 1_200_000 },
  ],
} = {}) {
  const samples = points.map(({ sizeMb, steps }) => {
    const r = memLatency({ sizeMb, steps });
    return { sizeMb, ns: r.ns };
  });
  // 主指标固定取 32MB 那一点：与套件 1.1.0 的口径一致，
  // 这样新旧客户端的原始值可比，不必因为"换了个采样点"就升套件版本。
  const main = samples.find((x) => x.sizeMb === 32) || samples[samples.length - 1];
  return { ns: main.ns, samples, detail: { mainSizeMb: main.sizeMb } };
}
