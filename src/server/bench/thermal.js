/**
 * 温度 / 频率 / 风扇采样。全部走未特权的 sysfs 路径，读不到就返回 null（并记录能力位），
 * 让上层能老实说"这台机器没有温度传感器"，而不是编一个数字。
 */
import fs from "node:fs";
import path from "node:path";

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
};

const list = (p) => {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
};

/** hwmon 名称 → 用途分类 */
function classify(name = "") {
  const n = name.toLowerCase();
  if (/k10temp|coretemp|zenpower|cpu_thermal|soc_thermal|x86_pkg_temp/.test(n)) return "cpu";
  if (/nvme/.test(n)) return "nvme";
  if (/amdgpu|i915|nouveau|radeon/.test(n)) return "gpu";
  if (/acpitz|pch|board/.test(n)) return "board";
  return "other";
}

const milli2c = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / 100) / 10;
};

let sensorCache = null;

/** 枚举一次传感器，后续采样复用（避免每秒扫目录） */
export function discover() {
  if (sensorCache) return sensorCache;
  const sensors = [];

  // thermal_zone*
  for (const zone of list("/sys/class/thermal").filter((z) => z.startsWith("thermal_zone"))) {
    const base = path.join("/sys/class/thermal", zone);
    const type = read(path.join(base, "type")) || zone;
    const temp = milli2c(read(path.join(base, "temp")));
    if (temp !== null) sensors.push({ kind: "temp", source: zone, label: type, category: classify(type), file: path.join(base, "temp") });
  }

  // hwmon: temp*_input + fan*_input
  for (const hm of list("/sys/class/hwmon").filter((h) => h.startsWith("hwmon"))) {
    const base = path.join("/sys/class/hwmon", hm);
    const name = read(path.join(base, "name")) || hm;
    for (const file of list(base)) {
      if (/^temp\d+_input$/.test(file)) {
        const labelFile = file.replace("_input", "_label");
        const label = read(path.join(base, labelFile)) || name;
        sensors.push({ kind: "temp", source: `${hm}/${file}`, label, category: classify(name), file: path.join(base, file) });
      }
      if (/^fan\d+_input$/.test(file)) {
        sensors.push({ kind: "fan", source: `${hm}/${file}`, label: name, category: "fan", file: path.join(base, file) });
      }
    }
  }

  // CPU 频率
  const cpus = list("/sys/devices/system/cpu").filter((c) => /^cpu\d+$/.test(c));
  const freqFiles = cpus.map((c) => path.join("/sys/devices/system/cpu", c, "cpufreq", "scaling_cur_freq")).filter((f) => fs.existsSync(f));
  const freqAvgFile = "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_avg_freq";
  let maxFreqKhz = null;
  for (const f of [path.join("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"), "/sys/devices/system/cpu/cpu0/cpufreq/amd_pstate_max_freq"]) {
    const v = Number(read(f));
    if (Number.isFinite(v) && v > 0) {
      maxFreqKhz = v;
      break;
    }
  }

  sensorCache = {
    sensors,
    freqFiles,
    freqAvgFile: fs.existsSync(freqAvgFile) ? freqAvgFile : null,
    maxFreqMhz: maxFreqKhz ? Math.round(maxFreqKhz / 1000) : null,
    hasCpuTemp: sensors.some((s) => s.kind === "temp" && s.category === "cpu"),
    hasFreq: freqFiles.length > 0 || fs.existsSync(freqAvgFile),
    hasFan: sensors.some((s) => s.kind === "fan"),
  };
  return sensorCache;
}

export function resetCache() {
  sensorCache = null;
}

/** 采一个样本。t 由调用方给出（秒，相对开始） */
export function sample(t = 0) {
  const d = discover();
  const temps = { cpu: null, gpu: null, nvme: null, board: null, other: null };
  let cpuMax = null;
  for (const s of d.sensors) {
    if (s.kind !== "temp") continue;
    const c = milli2c(read(s.file));
    if (c === null) continue;
    const cat = s.category in temps ? s.category : "other";
    if (temps[cat] === null || c > temps[cat]) temps[cat] = c;
    if (cat === "cpu" && (cpuMax === null || c > cpuMax)) cpuMax = c;
  }

  let freqMhz = null;
  if (d.freqFiles.length) {
    let sum = 0;
    let n = 0;
    for (const f of d.freqFiles) {
      const v = Number(read(f));
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        n += 1;
      }
    }
    if (n) freqMhz = Math.round(sum / n / 1000);
  }
  if (freqMhz === null && d.freqAvgFile) {
    const v = Number(read(d.freqAvgFile));
    if (Number.isFinite(v) && v > 0) freqMhz = Math.round(v / 1000);
  }

  let fanRpm = null;
  for (const s of d.sensors) {
    if (s.kind !== "fan") continue;
    const v = Number(read(s.file));
    if (Number.isFinite(v) && v > 0) {
      fanRpm = Math.max(fanRpm || 0, v);
    }
  }

  return {
    t: Math.round(t * 10) / 10,
    cpuC: temps.cpu,
    cpuMaxC: cpuMax,
    gpuC: temps.gpu,
    nvmeC: temps.nvme,
    boardC: temps.board,
    freqMhz,
    fanRpm,
  };
}

/**
 * 定时采样器。返回 { stop() }。
 * onSample 每秒被调一次；caller 负责把样本塞进内存序列。
 */
export function startSampler(onSample, intervalMs = 1000) {
  const started = Date.now();
  const emit = () => {
    try {
      onSample(sample((Date.now() - started) / 1000));
    } catch {
      /* 采样失败不能影响烤机 */
    }
  };
  emit(); // 立即给一个 t=0 的点
  const timer = setInterval(emit, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
    capabilities: () => {
      const d = discover();
      return { hasCpuTemp: d.hasCpuTemp, hasFreq: d.hasFreq, hasFan: d.hasFan, maxFreqMhz: d.maxFreqMhz };
    },
  };
}
