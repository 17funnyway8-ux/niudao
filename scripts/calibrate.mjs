/**
 * 基准校准：在本机完整跑一遍套件，把实测值写成 1000 分的基准。
 * 用法：node scripts/calibrate.mjs [目标目录]
 * 注意：只在干净的机器状态下校准（别在跑 Docker/转码时做）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../src/server/runner.js";
import { snapshot } from "../src/server/hardware.js";
import { formatMetric, METRICS, SUITE_VERSION } from "../src/shared/scoring.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] || path.join(ROOT, ".data");
fs.mkdirSync(target, { recursive: true });

console.log(`校准目标目录: ${target}`);
const hw = snapshot({ targetDir: target });
console.log(`机器: ${hw.hardware.cpu_model} / ${hw.hardware.threads} 线程 / ${hw.hardware.mem_gb}GB`);
console.log("");

const started = Date.now();
const run = await runSuite({
  targetDir: target,
  onEvent: (ev) => {
    if (ev.type === "stage" && ev.status === "start") process.stdout.write(`  → ${ev.label} ... `);
    if (ev.type === "stage" && ev.status === "done") console.log(`ok (${(ev.ms / 1000).toFixed(1)}s)`);
    if (ev.type === "stage" && ev.status === "error") console.log(`失败: ${ev.message}`);
  },
});

console.log("");
for (const [key, def] of Object.entries(METRICS)) {
  const v = run.metrics[key];
  console.log(`${def.label.padEnd(18, " ")} ${v === undefined ? "—" : formatMetric(key, v)}`);
}
if (run.caveats.length) console.log(`\n说明: ${run.caveats.join("; ")}`);
if (run.errors.length) console.log(`\n失败项: ${run.errors.join("; ")}`);

const missing = Object.keys(METRICS).filter((k) => run.metrics[k] === undefined);
if (missing.length) {
  console.error(`\n缺少指标: ${missing.join(", ")} —— 不写入基准，请先修好这些测试项`);
  process.exit(1);
}

const out = {
  suite: SUITE_VERSION,
  client: "1.0.0",
  measured_at: new Date().toISOString(),
  machine: {
    cpu_model: hw.hardware.cpu_model,
    arch: hw.arch,
    cores: hw.hardware.cores,
    threads: hw.hardware.threads,
    mem_gb: hw.hardware.mem_gb,
  },
  note: "1000 分 = 这台基准机的实测水平；分数只用于同套件版本内的横向比较。",
  metrics: run.metrics,
};
const file = path.join(ROOT, "src", "server", "data", "baselines.json");
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n已写入 ${path.relative(ROOT, file)}（总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
