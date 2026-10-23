/* 图表：手绘 SVG，但带交互（十字线 + tooltip）与阈值线。零依赖，跟页面同源。 */

const nf = (n, d = 0) =>
  Number.isFinite(n) ? n.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";

const W = 760;

/**
 * 折线图。scale 会一起塞进 JSON，供 hover 精确换算。
 * @param {Array<{t:number,value:number}>} points
 * @param {{color?:string,unit?:string,height?:number,label?:string,threshold?:number,thresholdLabel?:string,id:string}} opts
 */
export function lineChart(points, opts = {}) {
  const { color = "#d7ff3e", unit = "", height = 150, label = "", threshold = null, thresholdLabel = "" } = opts;
  const pts = (points || []).filter((p) => Number.isFinite(p?.value));
  if (pts.length < 2) return `<div class="chart-empty">数据点不足（${pts.length}/2）</div>`;

  const id = opts.id || `c${Math.random().toString(36).slice(2, 8)}`;
  const H = height;
  const PAD = { l: 44, r: 16, t: 18, b: 24 };
  const xMax = Math.max(...pts.map((p) => p.t)) || 1;
  const ys = pts.map((p) => p.value);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (Number.isFinite(threshold)) {
    lo = Math.min(lo, threshold);
    hi = Math.max(hi, threshold);
  }
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  lo -= span * 0.12;
  hi += span * 0.12;

  const X = (t) => PAD.l + (t / xMax) * (W - PAD.l - PAD.r);
  const Y = (v) => H - PAD.b - ((v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
  const areaD = `${d} L${X(pts[pts.length - 1].t).toFixed(1)},${H - PAD.b} L${X(pts[0].t).toFixed(1)},${H - PAD.b} Z`;

  const grid = [0, 0.5, 1]
    .map((f) => {
      const v = lo + (hi - lo) * (1 - f);
      const y = Y(v);
      return `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}" class="chart-grid"/>
        <text x="${PAD.l - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="chart-axis">${nf(Math.round(v))}</text>`;
    })
    .join("");

  const thLine = Number.isFinite(threshold)
    ? `<line x1="${PAD.l}" y1="${Y(threshold).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(threshold).toFixed(1)}" class="chart-threshold"/>
       <text x="${W - PAD.r}" y="${(Y(threshold) - 5).toFixed(1)}" text-anchor="end" class="chart-threshold-label">${thresholdLabel || `阈值 ${threshold}`}</text>`
    : "";

  const meta = { xMax, lo, hi, H, PAD, points: pts.map((p) => [p.t, p.value]) };

  return `<div class="chart" data-chart="${id}" data-unit="${unit}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label || "曲线图"}">
      ${grid}${thLine}
      <path d="${areaD}" fill="url(#grad-${id})" opacity="0.55"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(pts[pts.length - 1].t).toFixed(1)}" cy="${Y(pts[pts.length - 1].value).toFixed(1)}" r="3" fill="${color}"/>
      <g class="chart-cursor" opacity="0">
        <line y1="${PAD.t}" y2="${H - PAD.b}" class="chart-cursor-line"/>
        <circle r="4" fill="${color}"/>
      </g>
      <text x="${PAD.l}" y="${H - 6}" class="chart-axis">0s</text>
      <text x="${W - PAD.r}" y="${H - 6}" text-anchor="end" class="chart-axis">${Math.round(xMax)}s</text>
      <defs>
        <linearGradient id="grad-${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${color}" stop-opacity="0.4"/>
          <stop offset="1" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
    </svg>
    <div class="chart-tip" hidden></div>
    <script type="application/json" data-meta="${id}">${JSON.stringify(meta)}</script>
  </div>`;
}

/** 逐轮柱状图：稳定性判定用（最差/最好一眼可见） */
export function roundBars(values, { unit = "", best = null, worst = null } = {}) {
  const list = (values || []).filter((v) => Number.isFinite(v));
  if (!list.length) return `<div class="chart-empty">没有逐轮数据</div>`;
  const max = Math.max(...list);
  const min = Math.min(...list);
  const span = max - min || 1;
  return `<div class="rounds" role="img" aria-label="逐轮吞吐">
    ${list
      .map((v, i) => {
        const h = 34 + ((v - min) / span) * 56;
        const cls = v === best ? "best" : v === worst ? "worst" : "";
        return `<div class="round-col" title="第 ${i + 1} 轮：${nf(v, 1)} ${unit}"><i class="${cls}" style="height:${h}%"></i></div>`;
      })
      .join("")}
  </div>`;
}

/** 图表交互：十字线 + tooltip。事件委托，全站只绑一次。 */
export function bindChartHover(root = document) {
  root.addEventListener("mousemove", (ev) => {
    const box = ev.target.closest?.(".chart");
    if (!box) return;
    const metaEl = box.querySelector("script[data-meta]");
    const svg = box.querySelector("svg");
    if (!metaEl || !svg) return;
    let meta;
    try {
      meta = JSON.parse(metaEl.textContent);
    } catch {
      return;
    }
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const px = ev.clientX - rect.left;
    // 屏幕像素 → viewBox 坐标
    const vx = (px / rect.width) * W;
    const { PAD, xMax, lo, hi, H } = meta;
    const ratio = Math.min(1, Math.max(0, (vx - PAD.l) / (W - PAD.l - PAD.r)));
    const target = ratio * xMax;
    let best = meta.points[0];
    for (const p of meta.points) if (Math.abs(p[0] - target) < Math.abs(best[0] - target)) best = p;

    const cursor = svg.querySelector(".chart-cursor");
    if (cursor) {
      cursor.setAttribute("opacity", "1");
      const cx = PAD.l + (best[0] / xMax) * (W - PAD.l - PAD.r);
      const cy = H - PAD.b - ((best[1] - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
      const line = cursor.querySelector("line");
      line.setAttribute("x1", cx);
      line.setAttribute("x2", cx);
      const dot = cursor.querySelector("circle");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
    }

    const tip = box.querySelector(".chart-tip");
    if (tip) {
      tip.hidden = false;
      tip.textContent = `${Math.round(best[0])}s · ${nf(best[1], 1)}${box.dataset.unit || ""}`;
      const left = Math.min(box.clientWidth - 96, Math.max(0, px + 12));
      tip.style.left = `${left}px`;
    }
  });

  root.addEventListener("mouseleave", (ev) => {
    const box = ev.target.closest?.(".chart");
    if (!box) return;
    box.querySelector(".chart-cursor")?.setAttribute("opacity", "0");
    const tip = box.querySelector(".chart-tip");
    if (tip) tip.hidden = true;
  });
}
