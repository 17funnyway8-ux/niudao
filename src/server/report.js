/** 报告导出：Markdown / 纯文本成绩卡。用户可以直接贴到论坛。 */
import { DIMENSIONS, METRICS, formatMetric, gradeOf } from "../shared/scoring.js";

const fmtTime = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

function deepMarkdown(result) {
  const s = result.stability || {};
  const v = s.verdict || {};
  const lines = [];
  lines.push("# 牛刀 · 稳定性报告");
  lines.push("");
  lines.push(`> ${result.hardware.cpu_model} · ${result.hardware.threads} 线程 · ${result.hardware.mem_gb}GB 内存`);
  lines.push(`> 结论：**${v.headline || "数据不足"}** — ${v.detail || ""}`);
  const span = (result.burnedSec || 0) < 90 ? `${Math.round(result.burnedSec || 0)} 秒` : `${Math.round((result.burnedSec || 0) / 60)} 分钟`;
  lines.push(`> 满载 ${span}${result.loadDisk ? "（叠加磁盘写压力）" : ""} · 套件 v${result.suite} · 测于 ${fmtTime(result.ts)}`);
  lines.push("");

  if (s.perf) {
    lines.push("## 性能保持");
    lines.push("");
    lines.push("| 项目 | 数值 |");
    lines.push("| --- | ---: |");
    lines.push(`| 冷态多核吞吐 | ${s.perf.preMops} MOps/s |`);
    lines.push(`| 满载后多核吞吐 | ${s.perf.postMops} MOps/s |`);
    lines.push(`| 性能保持率 | **${s.perf.keepPct}%**（损失 ${s.perf.lossPct}%） |`);
    lines.push("");
  }

  if (s.temp) {
    lines.push("## 温度");
    lines.push("");
    lines.push("| 项目 | 数值 |");
    lines.push("| --- | ---: |");
    lines.push(`| 起始 | ${s.temp.startC}°C |`);
    lines.push(`| 满载结束 | ${s.temp.endC}°C |`);
    lines.push(`| 最高 | ${s.temp.maxC}°C |`);
    lines.push(`| 升温 | ${s.temp.riseC}°C |`);
    if (s.temp.plateauSec !== null) lines.push(`| 到达 90% 稳态用时 | ${s.temp.plateauSec}s |`);
    lines.push("");
  }

  if (s.freq) {
    lines.push("## 频率");
    lines.push("");
    lines.push("| 项目 | 数值 |");
    lines.push("| --- | ---: |");
    lines.push(`| 峰值 | ${s.freq.peakMhz} MHz |`);
    lines.push(`| 稳态 | ${s.freq.steadyMhz} MHz |`);
    if (s.freq.nominalMhz) lines.push(`| 标称最高 | ${s.freq.nominalMhz} MHz |`);
    if (s.freq.dropPct !== null) lines.push(`| 下降 | ${s.freq.dropPct}% |`);
    lines.push("");
  }

  if (Array.isArray(result.series) && result.series.length > 4) {
    lines.push("## 曲线采样（每 10% 取一点）");
    lines.push("");
    lines.push("| 时间 | CPU 温度 | 频率 |");
    lines.push("| ---: | ---: | ---: |");
    const step = Math.max(1, Math.floor(result.series.length / 10));
    for (let i = 0; i < result.series.length; i += step) {
      const p = result.series[i];
      lines.push(`| ${p.t}s | ${p.cpuC === null || p.cpuC === undefined ? "—" : `${p.cpuC}°C`} | ${p.freqMhz ? `${p.freqMhz} MHz` : "—"} |`);
    }
    lines.push("");
  }

  if (result.caveats?.length) {
    lines.push("## 说明");
    lines.push("");
    for (const c of result.caveats) lines.push(`- ${c}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("稳定性结论只看「满载前后性能保持率」，温度与频率仅作旁证。深度档不参与性能总分。");
  return lines.join("\n");
}

export function buildMarkdown(result) {
  if ((result.kind || "fast") === "deep") return deepMarkdown(result);
  const s = result.scores;
  const g = result.grade ?? gradeOf(s.composite);
  const lines = [];
  lines.push(`# 牛刀 · 性能报告`);
  lines.push("");
  lines.push(`> ${result.hardware.cpu_model} · ${result.hardware.threads} 线程 · ${result.hardware.mem_gb}GB 内存`);
  lines.push(`> 综合分 **${s.composite}**（${g.grade} 级 · ${g.label}）  ·  套件 v${result.suite}`);
  lines.push(`> 测于 ${fmtTime(result.ts)}`);
  lines.push("");
  lines.push("## 维度分");
  lines.push("");
  lines.push("| 维度 | 分数 | 权重 |");
  lines.push("| --- | ---: | ---: |");
  for (const [key, def] of Object.entries(DIMENSIONS)) {
    const d = s.dims[key];
    const val = d?.score === null || d?.score === undefined ? "—" : d.score;
    lines.push(`| ${def.label} | ${val} | ${Math.round(def.weight * 100)}% |`);
  }
  lines.push("");
  lines.push("## 原始指标");
  lines.push("");
  lines.push("| 指标 | 实测 | 归一化分 |");
  lines.push("| --- | ---: | ---: |");
  for (const [key, def] of Object.entries(METRICS)) {
    const raw = result.metrics[key];
    if (raw === undefined) continue;
    lines.push(`| ${def.label} | ${formatMetric(key, raw)} | ${s.subs[key] ?? "—"} |`);
  }
  lines.push("");
  lines.push("## 硬件");
  lines.push("");
  lines.push(`- CPU：${result.hardware.cpu_model}（${result.hardware.cores} 核 / ${result.hardware.threads} 线程）`);
  lines.push(`- 内存：${result.hardware.mem_gb} GB`);
  lines.push(`- 主板/整机：${result.hardware.board || "—"}`);
  lines.push(`- 核显/独显：${result.hardware.gpu || "—"}`);
  lines.push(`- 系统：fnOS ${result.hardware.os_version} / 内核 ${result.hardware.kernel}`);
  lines.push(`- 测试卷：${result.hardware.volume}`);
  if (result.hardware.disks?.length) lines.push(`- 存储：${result.hardware.disks.join("；")}`);
  lines.push("");
  if (result.caveats?.length) {
    lines.push("## 测试说明");
    lines.push("");
    for (const c of result.caveats) lines.push(`- ${c}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("分数含义：1000 = 基准机（AMD Ryzen 7 5825U）水平。跨套件版本不比较。");
  return lines.join("\n");
}

export function buildCard(result) {
  const g = result.grade ?? gradeOf(result.scores.composite);
  return [
    `牛刀 · 综合 ${result.scores.composite}（${g.grade}级 ${g.label}）`,
    `CPU ${result.scores.dims.cpu?.score ?? "—"} | 内存 ${result.scores.dims.memory?.score ?? "—"} | 存储 ${result.scores.dims.storage?.score ?? "—"}`,
    `${result.hardware.cpu_model} / ${result.hardware.mem_gb}GB`,
    `套件 v${result.suite}`,
  ].join("\n");
}
