/**
 * 成绩卡：一张能直接发群的图，而不是四行文字。
 *
 * 做法：纯 SVG 生成 → 存 .svg / 转 PNG / 复制到剪贴板 / 复制分享链接。
 * 全部在浏览器里完成，不依赖任何外部服务（二维码是内嵌的 qrcode-generator，
 * MIT 许可，见 vendor-qrcode.js 头部）。离线也能出图，这是底线。
 */
import qrcode from "./vendor-qrcode.js";

/** 天梯页的公开地址（卡片右下角的二维码指向这里，别人扫了就能看到榜） */
export function boardUrl(result) {
  const configured = (result?._leaderboardUrl || "").trim();
  if (configured) return configured.replace(/\/+$/, "") + "/";
  return "https://fnbench.1133891.xyz/";
}

function escapeXml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function qrSvg(url, x, y, size) {
  let q;
  try {
    q = qrcode(0, "M");
    q.addData(url);
    q.make();
  } catch {
    return "";
  }
  const n = q.getModuleCount();
  const cell = size / n;
  let rects = `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="4" fill="#ffffff"/>`;
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (q.isDark(r, c)) rects += `<rect x="${(x + c * cell).toFixed(2)}" y="${(y + r * cell).toFixed(2)}" width="${(cell + 0.1).toFixed(2)}" height="${(cell + 0.1).toFixed(2)}" fill="#101614"/>`;
    }
  }
  return `<g>${rects}</g>`;
}

/** 三个维度的条形（用分数本身着色：>=1100 绿、<800 橙） */
function dimRow(label, value, y, width = 380) {
  const v = Number.isFinite(value) ? Math.round(value) : null;
  const pct = v === null ? 0 : Math.max(0.03, Math.min(1, v / 1600));
  const color = v === null ? "#6b7280" : v >= 1100 ? "#2e7d5b" : v >= 900 ? "#3f7cac" : "#b4542a";
  return `
    <text x="60" y="${y}" class="dim-label">${escapeXml(label)}</text>
    <text x="205" y="${y}" class="dim-score" text-anchor="end">${v === null ? "—" : v.toLocaleString("en-US")}</text>
    <rect x="230" y="${y - 13}" width="${width}" height="10" rx="5" fill="#e8ecea"/>
    <rect x="230" y="${y - 13}" width="${Math.round(width * pct)}" height="10" rx="5" fill="${color}"/>`;
}

/** 生成 SVG 字符串。尺寸固定 1080×1350，适合手机查看和群聊转发。 */
export function scoreCardSvg(result, { leaderboardUrl = "" } = {}) {
  const s = result.scores || {};
  const hw = result.hardware || {};
  const composite = Math.round(s.composite || 0);
  const grade = result.grade?.grade || "B";
  const gradeLabel = result.grade?.label || "";
  const date = new Date(result.ts || Date.now());
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const url = leaderboardUrl ? leaderboardUrl.replace(/\/+$/, "") + "/" : boardUrl(result);
  const cpu = String(hw.cpu_model || "未知 CPU");
  const cpuShort = cpu.length > 44 ? cpu.slice(0, 43) + "…" : cpu;
  const mem = hw.mem_gb ? `${hw.mem_gb} GB` : "";
  const threads = hw.threads ? `${hw.threads} 线程` : "";
  const alias = result.alias || "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <defs>
    <style>
      text { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", -apple-system, "Segoe UI", sans-serif; }
      .brand { font-size: 34px; font-weight: 700; fill: #101614; letter-spacing: 1px; }
      .brand-sub { font-size: 20px; fill: #6b7280; }
      .score { font-size: 260px; font-weight: 750; fill: #101614; letter-spacing: -8px; font-variant-numeric: tabular-nums; }
      .score-unit { font-size: 26px; fill: #6b7280; }
      .grade { font-size: 22px; font-weight: 600; }
      .dim-label { font-size: 25px; fill: #4b5563; }
      .dim-score { font-size: 30px; font-weight: 650; fill: #101614; font-variant-numeric: tabular-nums; }
      .hw { font-size: 24px; fill: #101614; }
      .hw-sub { font-size: 21px; fill: #6b7280; }
      .foot { font-size: 20px; fill: #6b7280; }
      .qr-hint { font-size: 19px; fill: #4b5563; }
    </style>
  </defs>
  <rect width="1080" height="1350" fill="#f4f6f5"/>
  <rect x="0" y="0" width="1080" height="12" fill="#2e7d5b"/>

  <text x="60" y="100" class="brand">牛刀</text>
  <text x="60" y="136" class="brand-sub">飞牛 NAS 性能体检</text>
  <text x="1020" y="100" text-anchor="end" class="brand-sub">${escapeXml(alias || "未署名")}</text>

  <text x="60" y="430" class="score">${composite.toLocaleString("en-US")}</text>
  <text x="62" y="478" class="score-unit">综合分（基准机 = 1,000）</text>

  <g transform="translate(790,300)">
    <rect width="230" height="118" rx="14" fill="#101614"/>
    <text x="115" y="60" text-anchor="middle" class="grade" fill="#f4f6f5" style="font-size:44px;font-weight:700">${escapeXml(grade)}</text>
    <text x="115" y="94" text-anchor="middle" class="grade" fill="#9aa5a0" style="font-size:22px">${escapeXml(gradeLabel)}</text>
  </g>

  <rect x="60" y="540" width="960" height="1" fill="#dde3df"/>

  <g transform="translate(0,640)">
    ${dimRow("CPU 计算", s.dims?.cpu?.score, 0)}
    ${dimRow("内存", s.dims?.memory?.score, 90)}
    ${dimRow("存储 I/O", s.dims?.storage?.score, 180)}
  </g>

  <rect x="60" y="900" width="960" height="1" fill="#dde3df"/>

  <text x="60" y="990" class="hw">${escapeXml(cpuShort)}</text>
  <text x="60" y="1034" class="hw-sub">${escapeXml([mem, threads, "fnOS " + (hw.os_version || "")].filter(Boolean).join("  ·  "))}</text>

  <g transform="translate(0,1140)">
    ${qrSvg(url, 60, 0, 150)}
    <text x="240" y="52" class="qr-hint">扫码看天梯</text>
    <text x="240" y="88" class="qr-hint">你的 NAS 能跑多少分？</text>
    <text x="1020" y="52" text-anchor="end" class="foot">${dateStr}</text>
    <text x="1020" y="88" text-anchor="end" class="foot">套件 v${escapeXml(result.suite || "1.0.0")} · 客户端 v${escapeXml(result.client || "")}</text>
  </g>
</svg>`;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 直接下载 SVG（矢量、体积最小、任何地方都能打开） */
export function downloadScoreCardSvg(result, opts = {}) {
  const svg = scoreCardSvg(result, opts);
  download(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `niudao-${Math.round(result.scores?.composite || 0)}.svg`);
}

/** SVG 转 PNG。需要图片资源能加载（同源自绘 SVG，无跨域问题）。 */
export async function scoreCardPngBlob(result, opts = {}) {
  const svg = scoreCardSvg(result, opts);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("成绩卡渲染失败"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1350;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f4f6f5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 导出失败"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadScoreCardPng(result, opts = {}) {
  const blob = await scoreCardPngBlob(result, opts);
  download(blob, `niudao-${Math.round(result.scores?.composite || 0)}.png`);
}

/** 复制到剪贴板：直接贴进微信/QQ。不支持时调用方回退为下载 PNG。 */
export async function copyScoreCardImage(result, opts = {}) {
  const blob = await scoreCardPngBlob(result, opts);
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
    throw new Error("clipboard-unsupported");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/** 成绩卡预览用的 data URL（不用每次重新渲染） */
export function scoreCardDataUrl(result, opts = {}) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(scoreCardSvg(result, opts))}`;
}
