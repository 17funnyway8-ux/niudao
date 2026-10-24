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
 * 显卡名称：直接用飞牛系统自己的清单，不自己维护映射表。
 *
 * 飞牛在 /usr/trim/etc/gpu_device_info.json 里已经有整份 PCI 厂商/设备/子设备 → 产品名
 * 的映射（141 KB，来自 trim 自己的驱动支持清单），系统页面上显示的就是这份。
 * 我再手写一张"常见 ID 表"只会漏掉冷门卡，而且和系统显示对不上。
 *
 * 结构：{ "<vendorHex>": { "<deviceHex>": { "<subsystemOrRevision>": { "name": "..." } } } }
 * 子键含义：多数是子设备 ID 的高两位/低两位组合，也可能是 revision；
 * 取不到精确子键时，任取一个（同 device 下的 name 基本一致）。
 */
const FNOS_GPU_DB = "/usr/trim/etc/gpu_device_info.json";
let gpuDbCache = null;

function loadFnOsGpuDb() {
  if (gpuDbCache !== null) return gpuDbCache;
  try {
    gpuDbCache = JSON.parse(fs.readFileSync(FNOS_GPU_DB, "utf8"));
  } catch {
    gpuDbCache = {};
  }
  return gpuDbCache;
}

/** 在飞牛清单里查产品名。取不到返回空串（交给上层决定怎么退化）。 */
export function gpuNameFromFnOS(vendorHex, deviceHex) {
  const db = loadFnOsGpuDb();
  const vendor = db[vendorHex?.toUpperCase()] || db[vendorHex?.toLowerCase()];
  if (!vendor) return "";
  const dev = vendor[deviceHex?.toUpperCase()] || vendor[deviceHex?.toLowerCase()];
  if (!dev) return "";
  const first = dev["0000"] || dev["00"] || Object.values(dev)[0];
  return (first && first.name) || "";
}

function gpu() {
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
    const vendorHex = vendor.replace(/^0x/i, "").toLowerCase();
    const deviceHex = (device || "").replace(/^0x/i, "").toLowerCase();
    // 1) 飞牛系统自己的产品名清单（系统页面上显示的就是这个）
    let label = gpuNameFromFnOS(vendorHex, deviceHex);
    // 2) 清单里没有的（虚拟显卡、非常新的卡）：用内核驱动给的可读名，
    //    再不行就报"厂商 + 驱动"，不编造型号。
    if (!label) {
      const driverMatch = (read(`${base}/uevent`) || "").match(/DRIVER=(\S+)/);
      const driver = driverMatch ? driverMatch[1] : "";
      const driverLabel = {
        amdgpu: "AMD 显卡",
        i915: "Intel 显卡",
        xe: "Intel Arc 显卡",
        nvidia: "NVIDIA 显卡",
        nouveau: "NVIDIA 显卡（开源驱动）",
        "bochs-drm": "虚拟显卡（QEMU）",
        virtio_gpu: "虚拟显卡（virtio）",
        vkms: "虚拟显卡（无头）",
        "radeon": "AMD 显卡（旧驱动）",
      }[driver];
      const vendorName = PCI_VENDORS[`0x${vendorHex}`] || "";
      label = driverLabel || (vendorName ? `${vendorName} 显卡` : "");
    }
    if (!label) continue;
    // 同一张卡会有多个 DRM 节点（card0 / card0-DP-1 等），去重
    if (names.includes(label)) continue;
    names.push(label);
  }
  return names.join(" / ");
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
    gpu: gpu(),
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
