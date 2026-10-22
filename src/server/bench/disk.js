/**
 * 存储测试。
 * 顺序：dd + O_DIRECT（绕过页缓存），失败则退化为带缓存并明确标注。
 * 4K 随机：调用 Python 助手（O_DIRECT + mmap 对齐缓冲），拿 QD1 IOPS。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "random4k.py");

const clock = () => process.hrtime.bigint();
const secs = (a, b) => Number(b - a) / 1e9;

function freeGb(dir) {
  try {
    const st = fs.statfsSync(dir);
    return (st.bavail * st.bsize) / 1024 ** 3;
  } catch {
    return 0;
  }
}

function runDd(args, timeoutMs) {
  const r = spawnSync("dd", args, { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, LC_ALL: "C" } });
  return { ok: r.status === 0, status: r.status, stderr: (r.stderr || "").trim().slice(0, 300) };
}

export function diskSeq(targetDir, { sizeMb = 512 } = {}) {
  const caveats = [];
  const file = path.join(targetDir, ".niudao-seq.bin");
  const free = freeGb(targetDir);
  let mb = sizeMb;
  if (free > 0 && free < (sizeMb / 1024) * 4 + 0.5) {
    mb = Math.max(64, Math.floor((free * 1024) / 4));
    caveats.push(`可用空间不足，顺序测试文件缩小到 ${mb}MB`);
  }

  let direct = true;

  // ---- 顺序写 ----
  let tw = clock();
  let w = runDd(["if=/dev/zero", `of=${file}`, "bs=1M", `count=${mb}`, "oflag=direct", "conv=fdatasync", "status=none"], 180000);
  if (!w.ok) {
    direct = false;
    caveats.push("文件系统不支持 O_DIRECT，顺序测试含页缓存影响，数值仅供参考");
    tw = clock();
    w = runDd(["if=/dev/zero", `of=${file}`, "bs=1M", `count=${mb}`, "conv=fdatasync", "status=none"], 180000);
  }
  const writeSecs = secs(tw, clock());
  if (!w.ok) {
    fs.rmSync(file, { force: true });
    throw new Error(`顺序写失败: ${w.stderr || w.status}`);
  }

  // ---- 顺序读 ----
  let tr = clock();
  let r = runDd([`if=${file}`, "of=/dev/null", "bs=1M", ...(direct ? ["iflag=direct"] : []), "status=none"], 180000);
  if (!r.ok && direct) {
    direct = false;
    caveats.push("顺序读退化为带缓存模式");
    tr = clock();
    r = runDd([`if=${file}`, "of=/dev/null", "bs=1M", "status=none"], 180000);
  }
  const readSecs = secs(tr, clock());
  fs.rmSync(file, { force: true });
  if (!r.ok) throw new Error(`顺序读失败: ${r.stderr || r.status}`);

  const round = (n) => Math.round(n * 10) / 10;
  return {
    read_mbs: round(mb / readSecs),
    write_mbs: round(mb / writeSecs),
    detail: { sizeMb: mb, direct, readSecs: round(readSecs), writeSecs: round(writeSecs), freeGb: Math.round(free) },
    caveats,
  };
}

function pythonBin() {
  const candidates = [
    process.env.NIUDAO_PYTHON,
    "python3",
    "/var/apps/python312/target/bin/python3",
    "/usr/bin/python3",
  ].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["-c", "import os,mmap;print(1)"], { encoding: "utf8", timeout: 8000 });
    if (r.status === 0) return bin;
  }
  return null;
}

export function diskRandom(targetDir, { fileMb = 512, seconds = 6 } = {}) {
  const caveats = [];
  const bin = pythonBin();
  if (!bin) {
    return { read_iops: null, write_iops: null, detail: { skipped: "no-python" }, caveats: ["找不到可用的 python3，4K 随机 IO 未测（该项不计入分数）"] };
  }
  const file = path.join(targetDir, ".niudao-rand.bin");
  const free = freeGb(targetDir);
  let mb = fileMb;
  if (free > 0 && free < (fileMb / 1024) * 3 + 0.5) {
    mb = Math.max(128, Math.floor((free * 1024) / 3));
    caveats.push(`可用空间不足，随机测试文件缩小到 ${mb}MB`);
  }
  const args = [HELPER, "--path", file, "--file-mb", String(mb), "--seconds", String(seconds)];
  let out = spawnSync(bin, args, { encoding: "utf8", timeout: (seconds * 2 + 120) * 1000 });
  let parsed = null;
  try {
    parsed = JSON.parse((out.stdout || "").trim());
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.error) {
    // 有些文件系统（少数网络/特殊挂载）不支持 O_DIRECT，退化再试一次
    const retry = spawnSync(bin, [...args, "--no-direct"], { encoding: "utf8", timeout: (seconds * 2 + 120) * 1000 });
    try {
      parsed = JSON.parse((retry.stdout || "").trim());
      if (parsed) caveats.push("O_DIRECT 失败已退化为带缓存模式，随机 IO 数值偏乐观");
    } catch {
      caveats.push(`4K 随机测试失败: ${(out.stderr || retry.stderr || "").slice(0, 160)}`);
      parsed = null;
    }
  }
  fs.rmSync(file, { force: true });
  return {
    read_iops: parsed?.rand_read_iops ?? null,
    write_iops: parsed?.rand_write_iops ?? null,
    detail: {
      fileMb: parsed?.file_mb ?? mb,
      direct: parsed?.direct ?? null,
      readLatUs: parsed?.rand_read_lat_us ?? null,
      writeLatUs: parsed?.rand_write_lat_us ?? null,
    },
    caveats,
  };
}

/** 准备/清理测试目录。非递归创建：父目录必须存在，避免在特殊文件系统上死等。 */
export function prepareDir(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== "EEXIST") {
      const st = fs.statSync(dir); // 不存在就在这里抛错，让上层记录
      if (!st.isDirectory()) throw e;
    }
  }
  return dir;
}
