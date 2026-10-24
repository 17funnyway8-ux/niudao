/**
 * 硬件指纹与环境快照。全部使用未特权可读的 /proc、/sys 路径，读不到就降级并记录 warning。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
};

const readFirst = (...paths) => {
  for (const p of paths) {
    const v = read(p);
    if (v) return v;
  }
  return null;
};

/**
 * ARM 平台补充识别。
 * 在 Mac mini M4 上的 fnOS 虚机里，/proc/cpuinfo 既没有 model name 也没有 Model/Hardware，
 * 于是型号一路掉到 "unknown" —— 同型号榜也就没法用了。
 * 这里按顺序补三个来源：设备树 model、ARM MIDR 寄存器、常见 SoC 特征。
 */
function armModel(raw) {
  // 1) 设备树（裸金属 ARM 板子基本都有）
  for (const p of ["/proc/device-tree/model", "/sys/firmware/devicetree/base/model"]) {
    const v = read(p);
    if (v) return v.replace(/\u0000/g, "").trim();
  }
  // 2) DMI（虚拟机里 QEMU 会给个通用名，没信息量）
  const product = read("/sys/class/dmi/id/product_name");
  const vendor = read("/sys/class/dmi/id/sys_vendor");
  const combo = [vendor, product].filter(Boolean).join(" ").trim();
  const generic = /qemu|virtual machine|kvm|bochs|unknown/i.test(combo);
  // 3) MIDR：ARM 核心的实现者 + 型号号，能区分 Apple / Cortex-A / Neoverse
  const part = raw?.match(/^CPU part\s*:\s*(0x[0-9a-f]+)/im)?.[1];
  const impl = raw?.match(/^CPU implementer\s*:\s*(0x[0-9a-f]+)/im)?.[1]?.toLowerCase();
  const IMPLEMENTER = { "0x41": "ARM", "0x61": "Apple", "0x48": "HiSilicon", "0x51": "Qualcomm", "0x63": "Ampere" };
  const PART = {
    "0x022": "Cortex-A53", "0x023": "Cortex-A35", "0x029": "Cortex-A55", "0x02a": "Cortex-A56",
    "0x030": "Cortex-A97", "0x031": "Cortex-A76", "0x032": "Cortex-A57", "0x033": "Cortex-A72",
    "0x034": "Cortex-A75", "0x081": "Cortex-A78", "0x082": "Cortex-A78C", "0x0d0": "Cortex-X1",
    "0x0d2": "Cortex-X3", "0x0d8": "Neoverse-N1", "0x0d9": "Neoverse-N2",
  };
  if (impl || part) {
    const who = IMPLEMENTER[impl] || (impl ? `Impl${impl}` : "");
    const what = PART[part?.toLowerCase()] || (part ? `Part${part}` : "");
    const name = [who, what].filter(Boolean).join(" ");
    // QEMU 里 ARM 核心型号是真的；Apple 实现者 + 未知 part 时，多半是"私有核心 + 虚拟化报告的通用 part"，
    // 硬拼会得到 "Apple Cortex-A53" 这种自相矛盾的型号，所以只保留实现者，并在虚拟化时标注。
    const contradictory = IMPLEMENTER[impl] === "Apple" && PART[part?.toLowerCase()]?.startsWith("Cortex");
    if (name && !contradictory) return `${name}${generic ? " (虚拟机)" : ""}`;
    if (IMPLEMENTER[impl] === "Apple") return `Apple Silicon${generic ? " (虚拟机)" : ""}`;
  }
  // 4) 厂商/机型名至少比 unknown 强
  if (combo && !generic) return combo;
  return null;
}

function cpuInfo() {
  const warnings = [];
  const raw = read("/proc/cpuinfo");
  let cores = 0;
  let model = null;
  if (raw) {
    const m = raw.match(/^model name\s*:\s*(.+)$/m) || raw.match(/^Model\s*:\s*(.+)$/m) || raw.match(/^Hardware\s*:\s*(.+)$/m);
    model = m ? m[1].trim() : null;
    // 很多 ARM 机器把型号写在 Processor / 第一行 "CPU:" 后面
    if (!model) model = raw.match(/^Processor\s*:\s*(.+)$/m)?.[1]?.trim() || null;
    const ids = new Set();
    for (const block of raw.split(/\n\s*\n/)) {
      const phys = block.match(/^physical id\s*:\s*(\d+)/m);
      const core = block.match(/^core id\s*:\s*(\d+)/m);
      if (phys && core) ids.add(`${phys[1]}-${core[1]}`);
    }
    cores = ids.size;
  } else {
    warnings.push("读不到 /proc/cpuinfo，CPU 型号使用 Node 报告值");
  }
  // 走到这里还没有型号，说明是 ARM 虚机/特殊平台，再兜一层
  if (!model) model = armModel(raw);
  const threads = (() => {
    try {
      return os.availableParallelism();
    } catch {
      return os.cpus().length;
    }
  })();
  if (!model) model = os.cpus()?.[0]?.model?.trim() || "Unknown CPU";
  if (!cores) cores = Math.max(1, Math.round(threads / 2));
  return { model, cores, threads, warnings };
}

function osVersion() {
  const fnos = process.env.TRIM_SYS_VERSION || readFirst("/etc/fnos-version", "/etc/fnos/version", "/etc/trim/version");
  if (fnos) return fnos.split("\n")[0].trim();
  const rel = read("/etc/os-release");
  if (rel) {
    const m = rel.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  return `${os.type()} ${os.release()}`;
}

function board() {
  const vendor = readFirst("/sys/class/dmi/id/sys_vendor", "/sys/firmware/devicetree/base/model");
  const product = readFirst("/sys/class/dmi/id/product_name", "/sys/class/dmi/id/board_name");
  const parts = [vendor, product].filter(Boolean).map((s) => s.replace(/\u0000/g, "").trim());
  return parts.length ? parts.join(" ") : "";
}

const PCI_VENDORS = { "0x8086": "Intel", "0x1002": "AMD", "0x10de": "NVIDIA", "0x1a03": "ASPEED", "0x5143": "Qualcomm" };

/**
 * 显卡识别：优先给"人能看懂的产品名"。
 *
 * 数据来源优先级（越靠前越准）：
 *  1. lspci -mm 的型号字符串（x86 上有 PCI 数据库时最好用）
 *  2. /sys/class/drm 里每张卡的 vendor/device ID → 查常见 ID 表
 *  3. DRM 驱动的 name 属性（AMD/Intel 会给出比较可读的名字）
 *  4. 内核驱动名兜底（i915 / amdgpu / nvidia / xe）
 *
 * 核显要额外处理：Intel/AMD 的核显在部分主板上不会出现在 /sys/class/drm，
 * 但 CPU 型号里已经写明了（如 "Ryzen 7 5825U with Radeon Graphics"），
 * 这种情况直接从 CPU 型号推断，避免显示成"未识别"。
 */

/** 常见的核显/独显 PCI ID → 产品名（只收 NAS 上高频出现的这几类） */
const PCI_DEVICE_NAMES = {
  // Intel 核显（UHD/Iris Xe 世代）
  "0x3e9b": "Intel UHD Graphics 630",
  "0x3e92": "Intel UHD Graphics 630",
  "0x4692": "Intel Iris Xe Graphics",
  "0x46a6": "Intel Iris Xe Graphics",
  "0x46d0": "Intel Iris Xe Graphics",
  "0x4e61": "Intel UHD Graphics (11th)",
  "0xa780": "Intel UHD Graphics 770",
  "0x7d40": "Intel Graphics (Meteor Lake)",
  // NVIDIA 常见独显/Tesla
  "0x24b8": "NVIDIA GeForce RTX 2050 / MX570",
  "0x2204": "NVIDIA GeForce RTX 3090",
  "0x2482": "NVIDIA GeForce RTX 3060 Ti",
  "0x2504": "NVIDIA GeForce RTX 3060",
  "0x1f95": "NVIDIA GeForce GTX 1650",
  "0x1eb8": "NVIDIA Tesla T4",
  "0x2184": "NVIDIA GeForce GTX 1660",
  // AMD 核显
  "0x15e7": "AMD Radeon Graphics (APU)",
  "0x1638": "AMD Radeon Graphics (APU)",
  "0x164c": "AMD Radeon 680M",
  "0x15bf": "AMD Radeon 660M",
};

function gpuModelFallback(cpuModel = "") {
  // 从 CPU 型号里读出"集成显卡"的名字
  const m = cpuModel.match(/with\s+(Radeon[^,)/]*?Graphics[^,)]*|Intel[^,)]*Graphics[^,)]*|Iris[^,)]*Xe[^,)]*)/i);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  if (/Apple\s*(Silicon|M\d)/i.test(cpuModel)) return "Apple GPU（统一内存）";
  if (/Cortex-A|ARMv8/i.test(cpuModel)) return "ARM Mali / 集成 GPU";
  return "";
}

function gpu(cpuModel = "") {
  const drm = (() => {
    try {
      return fs.readdirSync("/sys/class/drm");
    } catch {
      return [];
    }
  })();
  const cards = drm.filter((d) => /^card\d+$/.test(d));
  const names = [];
  for (const card of cards) {
    const base = `/sys/class/drm/${card}/device`;
    const vendor = read(`${base}/vendor`);
    const device = read(`${base}/device`);
    if (!vendor) continue;
    const vname = PCI_VENDORS[vendor.toLowerCase()] || vendor;
    const devId = device ? device.toLowerCase() : "";
    const driverMatch = (read(`${base}/uevent`) || "").match(/DRIVER=(\S+)/);
    const driver = driverMatch ? driverMatch[1] : "";
    // 1) 已知 ID 表
    let label = PCI_DEVICE_NAMES[devId] || "";
    // 2) DRM 驱动自报的名字（AMD/Intel 的 drm 有 product_name / name）
    if (!label) {
      label = read(`${base}/product_name`) || read(`${base}/drm/${card}/device/product_name`) || "";
    }
    // 3) 兜底：厂商 + 可读驱动名，而不是裸的 0x 代号
    if (!label) {
      const driverLabel = { amdgpu: "AMD Radeon", i915: "Intel Graphics", xe: "Intel Arc Graphics", nvidia: "NVIDIA GPU", nouveau: "NVIDIA GPU（开源驱动）", "bochs-drm": "虚拟显卡（Bochs/QEMU）", virtio_gpu: "虚拟显卡（virtio）", vkms: "虚拟显卡（无头）" }[driver];
      label = driverLabel || `${vname} 显卡`;
    }
    if (names.includes(label)) continue; // 多显示器时同一张卡会重复出现
    names.push(label);
  }
  if (names.length) return names.join(" / ");

  // 没有 /sys/class/drm 信息：从 CPU 型号推断核显
  const integrated = gpuModelFallback(cpuModel);
  return integrated || "";
}

function mounts() {
  const raw = read("/proc/mounts");
  if (!raw) return [];
  const SKIP_FS = new Set(["overlay", "proc", "sysfs", "tmpfs", "devtmpfs", "squashfs", "fuse.sshfs", "nsfs", "cgroup2"]);
  const out = [];
  for (const line of raw.split("\n")) {
    const [dev, mount, fstype] = line.split(" ");
    if (!mount) continue;
    // 只要存储空间的顶层挂载点（/vol1、/vol2…）。btrfs 子卷、docker overlay、应用数据目录
    // 都会挂在 /volN 下面，全列出来只会让用户困惑。
    if (!/^\/vol\d+$/.test(mount)) continue;
    if (SKIP_FS.has(fstype)) continue;
    out.push({ dev, mount: mount.replace(/\\040/g, " "), fstype });
  }
  return out;
}

function diskKind(dev) {
  const name = path.basename(dev || "");
  if (!name) return "";
  const rot = read(`/sys/block/${name}/queue/rotational`);
  const model = read(`/sys/block/${name}/device/model`);
  if (rot === null) return model ? model.trim() : "";
  return `${rot === "1" ? "HDD" : "SSD"}${model ? ` ${model.trim()}` : ""}`;
}

function volumes() {
  const seen = new Map();
  for (const m of mounts()) {
    if (seen.has(m.mount)) continue;
    let sizeGb = 0;
    try {
      const st = fs.statfsSync(m.mount);
      sizeGb = Math.round((st.blocks * st.bsize) / 1024 ** 3);
    } catch {
      /* 无权限就算了 */
    }
    // /vol1 这类挂载点背后的块设备名通常无法直接拿到，尽量从 mounts 的 dev 推断
    seen.set(m.mount, { mount: m.mount, fstype: m.fstype, size_gb: sizeGb, kind: diskKind(m.dev) });
  }
  return [...seen.values()];
}

function thermals() {
  const zones = [];
  for (const base of ["/sys/class/thermal", "/sys/class/hwmon"]) {
    let entries = [];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.join(base, e);
      const type = read(path.join(dir, "type")) || read(path.join(dir, "name")) || e;
      let tempFiles = [];
      try {
        tempFiles = fs.readdirSync(dir).filter((f) => /^temp\d+_input$/.test(f));
      } catch {
        continue;
      }
      for (const tf of tempFiles) {
        const milli = Number(read(path.join(dir, tf)));
        if (!Number.isFinite(milli) || milli <= 0) continue;
        zones.push({ source: `${e}/${tf}`, type, celsius: Math.round(milli / 100) / 10 });
      }
    }
  }
  // 同类传感器取最高值，避免刷屏
  const byType = new Map();
  for (const z of zones) {
    const key = z.type.toLowerCase().replace(/\s+/g, "_");
    const prev = byType.get(key);
    if (!prev || z.celsius > prev.celsius) byType.set(key, { ...z, type: key });
  }
  return [...byType.values()].sort((a, b) => b.celsius - a.celsius).slice(0, 8);
}

function machineId() {
  const id = readFirst("/etc/machine-id", "/var/lib/dbus/machine-id");
  return id || os.hostname();
}

/** 常见内存规格（GiB）。可见容量比标称小一点是正常的（集显/固件预留）。 */
const MEM_STEPS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];

export function nominalCapacityGib(visibleGib) {
  if (!Number.isFinite(visibleGib) || visibleGib <= 0) return 1;
  const hit = MEM_STEPS.find((n) => n >= visibleGib && n - visibleGib <= Math.max(1, n * 0.08));
  return hit ?? Math.round(visibleGib);
}

export function fingerprintOf(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

/**
 * @param {{targetDir?: string}} opts
 */
export function snapshot(opts = {}) {
  const cpu = cpuInfo();
  const warnings = [...cpu.warnings];
  // 内存：系统只报"可用"容量（集显/固件会预留一部分），用户认知是"标称容量"。
  // 所以两个都给：mem_gib = 系统可见（精确），mem_gb = 标称容量（就近取整到常见规格）。
  const memBytes = os.totalmem();
  const memGib = Math.round((memBytes / 1024 ** 3) * 10) / 10;
  const memGb = nominalCapacityGib(memGib);
  const vols = volumes();
  const target = opts.targetDir || process.cwd();
  let volume = "";
  try {
    const st = fs.statfsSync(target);
    volume = `${path.parse(target).root}`;
    void st;
  } catch {
    warnings.push(`无法读取测试目录所在卷: ${target}`);
  }
  const hardware = {
    cpu_model: cpu.model,
    cores: cpu.cores,
    threads: cpu.threads,
    mem_gb: memGb,
    mem_gib: memGib,
    os_version: osVersion(),
    kernel: os.release(),
    board: board(),
    gpu: gpu(cpu.model),
    volume: target,
    disks: vols.map((v) => `${v.mount} ${v.fstype} ${v.size_gb}GB${v.kind ? ` ${v.kind}` : ""}`),
  };
  const fingerprint = fingerprintOf({
    cpu: hardware.cpu_model,
    arch: os.arch(),
    cores: hardware.cores,
    threads: hardware.threads,
    mem: hardware.mem_gb,
    board: hardware.board,
    id: machineId(),
  });
  return {
    hardware,
    arch: os.arch(),
    hostname: os.hostname(),
    volumes: vols,
    thermals: thermals(),
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    uptime_hours: Math.round(os.uptime() / 360) / 10,
    fingerprint,
    warnings,
  };
}
