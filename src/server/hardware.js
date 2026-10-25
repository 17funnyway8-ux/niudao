/**
 * 硬件指纹与环境快照。
 *
 * 数据来源原则（这个顺序别改）：
 *  1. **飞牛系统自己的数据**：/usr/trim/etc/gpu_device_info.json（GPU 产品名）、
 *     /usr/share/misc/pci.ids（PCI 厂商与设备名）—— 系统页面上显示的就是这些，
 *     用它们才能和用户在飞牛"设备信息"里看到的一致。
 *  2. **内核的权威接口**：/proc/cpuinfo、/sys/class/dmi/id/*（CPU 型号、内存容量、
 *     主板型号）—— 系统自己也是从这些地方读的，不存在"映射表"问题。
 *  3. **最后才兜底**（ARM 虚机上 /proc/cpuinfo 空的场景）：MIDR 寄存器。
 *
 * 反面教训：我给 GPU 手写过一张 20 条的 PCI ID 表，结果把 RTX A3000 认成了
 * "RTX 2050 / MX570"，和系统显示对不上。凡是系统里已有现成数据，就别自己造。
 *
 * 注意：com.trim.sysinfo 的 RPC socket（/run/trim_app_cgi/sysinfo）只有
 * OfficialAppUsers 组可读，第三方应用不在该组，所以走文件而不是 RPC。
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

/**
 * 整机/主板型号。
 * DMI 里有一堆厂商占位符（"Default string"、"To Be Filled By O.E.M." 等），
 * 直接拼起来会得到 "Default string DS2501" 这种半截垃圾，必须先过滤。
 * 优先用 board_vendor + board_name（主板），没有再退回 sys_vendor + product_name。
 */
const DMI_PLACEHOLDERS = /^(default string|to be filled by o\.e\.m\.?|system product name|system manufacturer|oem|none|unknown|not specified|n\/a|-+)$/i;

function cleanDmi(v) {
  const s = String(v || "").replace(/\u0000/g, "").trim();
  return s && !DMI_PLACEHOLDERS.test(s) ? s : "";
}

function board() {
  const candidates = [
    [read("/sys/class/dmi/id/board_vendor"), read("/sys/class/dmi/id/board_name")],
    [read("/sys/class/dmi/id/sys_vendor"), read("/sys/class/dmi/id/product_name")],
    [read("/sys/firmware/devicetree/base/model"), null], // ARM 裸板
  ];
  for (const [v, n] of candidates) {
    const parts = [cleanDmi(v), cleanDmi(n)].filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return "";
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
const PCI_IDS = "/usr/share/misc/pci.ids";
let gpuDbCache = null;
let pciIdsCache = null;

function loadFnOsGpuDb() {
  if (gpuDbCache !== null) return gpuDbCache;
  try {
    gpuDbCache = JSON.parse(fs.readFileSync(FNOS_GPU_DB, "utf8"));
  } catch {
    gpuDbCache = {};
  }
  return gpuDbCache;
}

/**
 * 系统自带的 pci.ids（pciutils 的数据库，1.3 MB，2023-04 版）。
 * 飞牛的 gpu_device_info.json 只收了它自己驱动支持范围内的卡，新卡可能没有；
 * pci.ids 更全，作为第二来源，仍然属于"系统的现成数据"，不是我手写的表。
 */
function loadPciIds() {
  if (pciIdsCache !== null) return pciIdsCache;
  const db = { vendors: {}, devices: {} };
  try {
    let vendor = "";
    for (const line of fs.readFileSync(PCI_IDS, "utf8").split("\n")) {
      if (!line || line.startsWith("#")) continue;
      if (!line.startsWith("\t")) {
        const m = line.match(/^([0-9a-f]{4})\s+(.+)$/i);
        if (m) vendor = m[1].toLowerCase(), (db.vendors[vendor] = m[2].trim());
      } else if (line.startsWith("\t") && !line.startsWith("\t\t")) {
        const m = line.match(/^\t([0-9a-f]{4})\s+(.+)$/i);
        if (m && vendor) db.devices[`${vendor}:${m[1].toLowerCase()}`] = m[2].trim();
      }
    }
  } catch {
    /* 没有 pci.ids 就只用飞牛清单 */
  }
  pciIdsCache = db;
  return db;
}

/**
 * 显卡产品名。优先飞牛清单（和系统"设备信息"页显示一致），
 * 其次系统 pci.ids，最后才退化为驱动可读名。查不到就不写，不编。
 */
export function gpuNameFromFnOS(vendorHex, deviceHex) {
  const v = String(vendorHex || "").toLowerCase();
  const d = String(deviceHex || "").toLowerCase();
  if (!v || !d) return "";

  // 1) 飞牛清单：{"10DE": {"24B8": {"0000": {"name": "RTX A3000 Laptop GPU"}}}}
  const db = loadFnOsGpuDb();
  const vendor = db[v.toUpperCase()] || db[v];
  const dev = vendor ? vendor[d.toUpperCase()] || vendor[d] : null;
  if (dev) {
    const first = dev["0000"] || dev["00"] || Object.values(dev)[0];
    if (first?.name) return String(first.name).trim();
  }

  // 2) 系统 pci.ids（去掉 [代号] 后缀，只留产品名）
  const pci = loadPciIds();
  const hit = pci.devices[`${v}:${d}`];
  if (hit) {
    const clean = hit.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    return clean || hit;
  }
  return "";
}

/** 厂商名也取自系统 pci.ids，不再手写映射 */
function vendorName(vendorHex) {
  const v = String(vendorHex || "").toLowerCase();
  const pci = loadPciIds();
  return pci.vendors[v] || "";
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
      const vname = vendorName(vendorHex);
      label = driverLabel || (vname ? `${vname} 显卡` : "");
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

/**
 * 把 /proc/mounts 里的设备名一路追到底层物理盘。
 *
 * fnOS 的卷层次比想象的深：/dev/mapper/trim_<uuid>-0 → dm-N → mdN(软 RAID) → sda/sdb/nvme0n1。
 * 原来只取 basename 去查 /sys/block/<name>/queue/rotational，分区和 dm 都查不到，
 * 于是界面上永远看不出是固态还是机械。这里顺着 slaves 递归到底。
 */
function blockSysName(dev) {
  const base = path.basename(String(dev || ""));
  if (!base) return "";
  // /dev/mapper/xxx 的 base 是 dm 别名，/sys/class/block/<别名> 不存在，
  // 要反查 /sys/block/dm-*/dm/name 找到真正的 dm-N
  if (!fs.existsSync(`/sys/class/block/${base}`)) {
    try {
      for (const d of fs.readdirSync("/sys/block")) {
        if (!d.startsWith("dm-")) continue;
        if (read(`/sys/block/${d}/dm/name`) === base) return d;
      }
    } catch {
      /* ignore */
    }
    return base;
  }
  return base;
}

/** 分区 → 整盘：sda1→sda、nvme0n1p2→nvme0n1、mmcblk0p1→mmcblk0 */
function wholeDiskOf(name) {
  const m = String(name || "").match(/^(nvme\d+n\d+|mmcblk\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+)(p?\d+)?$/i);
  return m ? m[1] : name;
}

/**
 * 递归收集底层物理盘。
 * 判断顺序很重要：**先看有没有 slaves**（dm / md 这类虚拟设备都有 slaves，
 * 而且 md 自己也带 queue/rotational，先读它就会把 RAID 阵列当成一块"没有型号的盘"），
 * 只有到底了（没有 slaves）才认为它是物理盘。
 */
function physicalDisks(dev, depth = 0) {
  const name = blockSysName(dev);
  if (!name || depth > 5) return [];
  let slaves = [];
  try {
    slaves = fs.readdirSync(`/sys/block/${name}/slaves`);
  } catch {
    slaves = [];
  }
  if (slaves.length) {
    const out = [];
    for (const sl of slaves) out.push(...physicalDisks(sl, depth + 1));
    return out;
  }
  const whole = wholeDiskOf(name);
  const rot = read(`/sys/block/${whole}/queue/rotational`);
  if (rot === null) return [];
  return [{ name: whole, rotational: rot === "1", model: (read(`/sys/block/${whole}/device/model`) || "").trim() }];
}

/** 卷的介质类型：底层盘里有任一机械盘就算 HDD（其余按 SSD） */
function volumeKind(dev) {
  const disks = physicalDisks(dev);
  if (!disks.length) return "";
  const hdd = disks.filter((d) => d.rotational);
  const kind = hdd.length ? (hdd.length === disks.length ? "HDD" : "SSD+HDD") : "SSD";
  const models = [...new Set(disks.map((d) => d.model).filter(Boolean))];
  const label = models.length === 1 ? models[0] : models.length ? `${models.length} 种盘` : "";
  return [kind, disks.length > 1 ? `${disks.length} 块` : "", label].filter(Boolean).join(" ");
}

function volumes() {
  const seen = new Map();
  for (const m of mounts()) {
    if (seen.has(m.mount)) continue;
    let sizeGb = 0;
    let freeGb = null;
    try {
      const st = fs.statfsSync(m.mount);
      sizeGb = Math.round((st.blocks * st.bsize) / 1024 ** 3);
      freeGb = Math.round((st.bavail * st.bsize) / 1024 ** 3);
    } catch {
      /* 权限不足就留空 */
    }
    const device = blockSysName(m.dev);
    seen.set(m.mount, {
      mount: m.mount,
      fstype: m.fstype,
      size_gb: sizeGb,
      free_gb: freeGb,
      device,
      disks: physicalDisks(m.dev).length,
      kind: volumeKind(m.dev),
    });
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
