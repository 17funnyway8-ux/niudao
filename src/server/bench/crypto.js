/** 真实负载：AES-256-GCM（SMB/HTTPS 加密）与 zlib（备份压缩）。都走原生实现，架构公平。 */
import { createCipheriv, randomBytes } from "node:crypto";
import zlib from "node:zlib";

/**
 * AES-256-GCM 吞吐。块开大一点：每建一个 cipher 有固定开销，块太小会测成"建 cipher 的速度"。
 * 256MB / 32MB 块 ≈ 0.2s，既能反映硬件 AES 单元，又不至于噪声压倒信号。
 */
export function aesThroughput(totalMb = 256, chunkMb = 32) {
  const chunk = randomBytes(chunkMb * 1024 * 1024);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const rounds = Math.max(1, Math.round(totalMb / chunkMb));

  const once = () => {
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.update(chunk);
    c.final();
  };
  for (let i = 0; i < 2; i += 1) once(); // 预热：让 OpenSSL 走完首次初始化

  let best = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const t0 = performance.now();
    for (let i = 0; i < rounds; i += 1) once();
    const dt = performance.now() - t0;
    const mbs = (rounds * chunkMb) / (dt / 1000);
    if (mbs > best) best = mbs;
  }
  return { mbs: Math.round(best * 10) / 10, detail: { totalMb: rounds * chunkMb, chunkMb } };
}

export function zlibThroughput(sizeMb = 32, level = 6) {
  // 造一份"半压缩"数据：4 bit/字节的信息熵，压缩率约 50%，既不会秒过也不会卡死，
  // 更接近备份真实遇到的混合内容。按 1MB 生成再重复铺满，避免每次都跑 3200 万次循环。
  const blockMb = Math.min(1, sizeMb);
  const block = Buffer.alloc(blockMb * 1024 * 1024);
  const alphabet = Buffer.from("abcdefghijklmnop");
  let s = 0x9e3779b9;
  for (let i = 0; i < block.length; i += 1) {
    // xorshift32：低 4 位不会以 16 字节为周期重复，否则整块会退化成"16 字节重复"
    s ^= (s << 13) >>> 0;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    s >>>= 0;
    block[i] = alphabet[s & 15];
  }
  const buf = Buffer.alloc(sizeMb * 1024 * 1024);
  for (let off = 0; off < buf.length; off += block.length) {
    block.copy(buf, off, 0, Math.min(block.length, buf.length - off));
  }

  let best = 0;
  let outBytes = 0;
  for (let i = 0; i < 2; i += 1) {
    const t0 = performance.now();
    const out = zlib.deflateSync(buf, { level });
    const dt = performance.now() - t0;
    outBytes = out.length;
    const mbs = sizeMb / (dt / 1000);
    if (mbs > best) best = mbs;
  }
  return {
    mbs: Math.round(best * 10) / 10,
    detail: { sizeMb, level, ratio: Math.round((outBytes / buf.length) * 1000) / 1000 },
  };
}
