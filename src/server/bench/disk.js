/**
 * 存储测试。
 * 顺序：dd + O_DIRECT（绕过页缓存），失败则退化为带缓存并明确标注。
 * 4K 随机：调用 Python 助手（O_DIRECT + mmap 对齐缓冲），拿 QD1 IOPS。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "random4k.py");

const clock = () => process.hrtime.bigint();
const secs = (a, b) => Number(b - a) / 1e9;

/**
 * 剩余空间 / 删测试文件都走异步 fs。
 * 原来用 statfsSync / rmSync —— 磁盘被 dd 打满时，这两下能各卡好几秒，
 * 主线程跟着冻住，页面上的进度条就定住了（实测 disk_seq 期间阻塞 3.9s）。
 */
async function freeGb(dir) {
  try {
    const st = await fs.promises.statfs(dir);
    return (st.bavail * st.bsize) / 1024 ** 3;
  } catch {
    return 0;
  }
}

async function rmQuiet(file) {
  try {
    await fs.promises.rm(file, { force: true });
  } catch {
    /* 删不掉不影响结论 */
  }
}

/**
 * 起子进程跑完再回来（异步）。
 * 这里原来用 spawnSync —— 打盘的那十几秒会把整个 http 服务冻住，
 * 进度轮询全超时，用户看到的就是"卡死"。dd / python 都是外部命令，
 * 没有任何理由让主线程陪着等。
 */
function run(bin, args, timeoutMs, { onLine } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env: { ...process.env, LC_ALL: "C" } });
    } catch (err) {
      resolve({ ok: false, status: -1, stdout: "", stderr: String(err?.message || err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, status: -1, stdout, stderr: `超时 ${timeoutMs}ms` });
    }, timeoutMs);
    let pending = "";
    child.stdout?.on("data", (c) => {
      stdout += c;
      if (!onLine) return;
      pending += c;
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.trim()) {
          try {
            onLine(JSON.parse(line));
          } catch {
            /* 非 JSON 行忽略 */
          }
        }
        nl = pending.indexOf("\n");
      }
    });
    // dd 的 status=progress 只在小文件/快盘上不会输出中间行，所以自己按字节量算速率。
    // 解析所有形如 "123456 bytes ... 123 MB/s" 的片段（中文系统下也可能是 "字节"），
    // 只用于界面显示，不参与计分。
    child.stderr?.on("data", (c) => {
      stderr += c;
      if (!onLine) return;
      const text = String(c);
      const units = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
      const re = /(\d[\d,]*)\s*(?:bytes|字节)[^\n\r]*?,\s*([\d.,]+)\s*([kKMGT]?B)\/s/g;
      let m;
      while ((m = re.exec(text))) {
        const bytes = Number(m[1].replace(/,/g, ""));
        const mbs = (Number(m[2].replace(",", ".")) * (units[m[3]] || 1e6)) / 1e6;
        if (Number.isFinite(mbs) && mbs > 0) {
          try {
            onLine({ bytes, mbs: Math.round(mbs * 10) / 10 });
          } catch {
            /* 忽略 */
          }
        }
      }
    });
    child.on("error", (err) => finish({ ok: false, status: -1, stdout, stderr: String(err?.message || err) }));
    child.on("close", (code) => finish({ ok: code === 0, status: code, stdout, stderr }));
  });
}

async function runDd(args, timeoutMs, opts = {}) {
  const r = await run("dd", args, timeoutMs, opts);
  return { ok: r.ok, status: r.status, stderr: (r.stderr || "").trim().slice(0, 300) };
}

export async function diskSeq(targetDir, { sizeMb = 512, onProgress } = {}) {
  const caveats = [];
  const file = path.join(targetDir, ".niudao-seq.bin");
  const free = await freeGb(targetDir);
  let mb = sizeMb;
  if (free > 0 && free < (sizeMb / 1024) * 4 + 0.5) {
    mb = Math.max(64, Math.floor((free * 1024) / 4));
    caveats.push(`可用空间不足，顺序测试文件缩小到 ${mb}MB`);
  }

  let direct = true;

  // ---- 顺序写 ----
  // 计时口径修正：这里测的是"写吞吐"，不是 fsync 延迟。
  // 原来用 conv=fdatasync 让 dd 在退出前落盘，但那段 fsync 时间也被算进了 wall time，
  // 于是写在内存里被吞掉（virtio/QEMU 虚机尤其明显）、或者盘上队列深时，
  // 会把 8 GB/s 甚至几万 MB/s 当成磁盘速度。现在：不 fsync，结束单独 fsync 并只记录不扣分。
  let tw = clock();
  let w = await runDd(["if=/dev/zero", `of=${file}`, "bs=1M", `count=${mb}`, "oflag=direct", "status=progress"], 180000, {
    onLine: (line) => { try { onProgress?.({ phase: "write", ...line }); } catch { /* 忽略 */ } },
  });
  if (!w.ok) {
    direct = false;
    caveats.push("文件系统不支持 O_DIRECT，顺序测试含页缓存影响，数值仅供参考");
    tw = clock();
    w = await runDd(["if=/dev/zero", `of=${file}`, "bs=1M", `count=${mb}`, "status=progress"], 180000, {
      onLine: (line) => { try { onProgress?.({ phase: "write", ...line }); } catch { /* 忽略 */ } },
    });
  }
  const writeSecs = secs(tw, clock());
  if (!w.ok) {
    await rmQuiet(file);
    throw new Error(`顺序写失败: ${w.stderr || w.status}`);
  }
  // 单独测一次 fsync，只作参考展示（真机 ~几十 ms，虚机可能几秒 —— 这正是"假快"的来源）
  const fsyncStart = clock();
  await run("sync", [], 60000).catch(() => {});
  const fsyncSecs = secs(fsyncStart, clock());

  // ---- 顺序读 ----
  let tr = clock();
  let r = await runDd([`if=${file}`, "of=/dev/null", "bs=1M", ...(direct ? ["iflag=direct"] : []), "status=progress"], 180000, {
    onLine: (line) => { try { onProgress?.({ phase: "read", ...line }); } catch { /* 忽略 */ } },
  });
  if (!r.ok && direct) {
    direct = false;
    caveats.push("顺序读退化为带缓存模式");
    tr = clock();
    r = await runDd([`if=${file}`, "of=/dev/null", "bs=1M", "status=progress"], 180000, {
      onLine: (line) => { try { onProgress?.({ phase: "read", ...line }); } catch { /* 忽略 */ } },
    });
  }
  const readSecs = secs(tr, clock());
  await rmQuiet(file);
  if (!r.ok) throw new Error(`顺序读失败: ${r.stderr || r.status}`);

  const round = (n) => Math.round(n * 10) / 10;
  return {
    read_mbs: round(mb / readSecs),
    write_mbs: round(mb / writeSecs),
    detail: {
      sizeMb: mb,
      direct,
      readSecs: round(readSecs),
      writeSecs: round(writeSecs),
      // fsync 耗时只展示、不计分：它衡量的是"落盘延迟"，不是"写吞吐"
      fsyncSecs: round(fsyncSecs),
      freeGb: Math.round(free),
    },
    caveats,
  };
}

/** 4K 助手现在会边跑边吐进度行，最后一行（final:true）才是结果；老版本整段 JSON 也兼容 */
function parseHelperOutput(text) {
  const lines = String(text || "").split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && obj.final !== undefined) return obj;
    } catch {
      /* 不是 JSON 行 */
    }
  }
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

async function pythonBin() {
  const candidates = [
    process.env.NIUDAO_PYTHON,
    "python3",
    "/var/apps/python312/target/bin/python3",
    "/usr/bin/python3",
  ].filter(Boolean);
  for (const bin of candidates) {
    const r = await run(bin, ["-c", "import os,mmap;print(1)"], 8000);
    if (r.status === 0) return bin;
  }
  return null;
}

export async function diskRandom(targetDir, { fileMb = 512, seconds = 6, onProgress } = {}) {
  const caveats = [];
  const bin = await pythonBin();
  if (!bin) {
    return { read_iops: null, write_iops: null, detail: { skipped: "no-python" }, caveats: ["找不到可用的 python3，4K 随机 IO 未测（该项不计入分数）"] };
  }
  const file = path.join(targetDir, ".niudao-rand.bin");
  const free = await freeGb(targetDir);
  let mb = fileMb;
  if (free > 0 && free < (fileMb / 1024) * 3 + 0.5) {
    mb = Math.max(128, Math.floor((free * 1024) / 3));
    caveats.push(`可用空间不足，随机测试文件缩小到 ${mb}MB`);
  }
  const args = [HELPER, "--path", file, "--file-mb", String(mb), "--seconds", String(seconds)];
  const opts = { onLine: (line) => { try { onProgress?.(line); } catch { /* 回调出错不影响测试 */ } } };
  const out = await run(bin, args, (seconds * 2 + 120) * 1000, opts);
  let parsed = null;
  try {
    parsed = parseHelperOutput(out.stdout);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.error) {
    // 有些文件系统（少数网络/特殊挂载）不支持 O_DIRECT，退化再试一次
    const retry = await run(bin, [...args, "--no-direct"], (seconds * 2 + 120) * 1000, opts);
    try {
      parsed = parseHelperOutput(retry.stdout);
      if (parsed) caveats.push("O_DIRECT 失败已退化为带缓存模式，随机 IO 数值偏乐观");
    } catch {
      caveats.push(`4K 随机测试失败: ${(out.stderr || retry.stderr || "").slice(0, 160)}`);
      parsed = null;
    }
  }
  await rmQuiet(file);
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
