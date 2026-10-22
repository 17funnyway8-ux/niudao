/** 报告导出：Markdown / 纯文本成绩卡。用户可以直接贴到论坛。 */
import { DIMENSIONS, METRICS, formatMetric, gradeOf } from "../shared/scoring.js";

const fmtTime = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

export function buildMarkdown(result) {
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
