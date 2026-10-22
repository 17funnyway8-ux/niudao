/* 牛刀前端：零框架、零依赖，全部视图用原生 DOM 拼装。 */

const $ = (sel, root = document) => root.querySelector(sel);
const appEl = () => $("#app");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n, digits = 0) =>
  typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "—";

const state = {
  boot: null,
  view: "home",
  resultId: null,
  result: null,
  run: null,
  poll: null,
  board: { dim: "overall", arch: "", data: null, loading: false, error: null },
  deep: { durationSec: 600, loadDisk: false, liveSeries: [] },
};

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data;
}

function toast(message, kind = "") {
  const wrap = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 6000 : 3200);
}

/* ---------------- shared bits ---------------- */
const GRADE_ORDER = ["S", "A", "B", "C", "D"];

function gradeBadge(grade, label) {
  const g = grade || "D";
  return `<span class="grade ${esc(g)}">${esc(g)} 级${label ? ` · ${esc(label)}` : ""}</span>`;
}

function gaugeSvg(score, cap = 1800) {
  const clamped = Math.max(0, Math.min(score || 0, cap));
  const ratio = clamped / cap;
  const start = -210;
  const sweep = 240;
  const angle = start + sweep * ratio;
  const r = 62;
  const cx = 90;
  const cy = 86;
  const arc = (a0, a1, stroke, width, opacity = 1) => {
    const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" opacity="${opacity}"/>`;
  };
  const needle = (() => {
    const a = (angle * Math.PI) / 180;
    const x = cx + (r - 12) * Math.cos(a);
    const y = cy + (r - 12) * Math.sin(a);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#d7ff3e" stroke-width="3" stroke-linecap="round"/>`;
  })();
  return `<svg class="gauge" viewBox="0 0 180 130" role="img" aria-label="综合分仪表">
    ${arc(start, start + sweep, "#1b2732", 12)}
    ${score ? arc(start, angle, "url(#gaugeGrad)", 12) : ""}
    ${arc(-30, -30, "#3a4b5a", 3)}
    <circle cx="${cx}" cy="${cy}" r="5" fill="#d7ff3e"/>
    ${score ? needle : ""}
    <defs><linearGradient id="gaugeGrad" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#8fe04a"/><stop offset="1" stop-color="#d7ff3e"/>
    </linearGradient></defs>
    <text x="${cx}" y="${cy + 30}" text-anchor="middle" fill="#5d6d7c" font-size="10" font-family="monospace">基准 ${num(1000)}</text>
  </svg>`;
}

function dimBlock(key, dim, data) {
  const score = data?.score;
  const cls = key === "cpu" ? "" : key === "memory" ? "blue" : "violet";
  const pct = score ? Math.max(2, Math.min(100, (score / 1600) * 100)) : 0;
  const weight = Math.round((dim.weight || 0) * 100);
  return `<div class="dim">
    <div class="dim-top">
      <span class="dim-name">${esc(dim.label)}</span>
      <span class="dim-weight">权重 ${weight}%</span>
      <span class="dim-score">${score === null || score === undefined ? "—" : num(score)}</span>
    </div>
    <div class="bar ${cls} tick"><i style="width:${pct}%"></i></div>
    <div class="dim-blurb">${esc(dim.blurb || "")}</div>
  </div>`;
}

const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const VERDICT_TONE = { good: "good", ok: "warn", warn: "warn", bad: "bad", unknown: "" };

function verdictPill(level, headline) {
  if (!headline) return "";
  return `<span class="pill ${VERDICT_TONE[level] || ""}">${esc(headline)}</span>`;
}

/** 折线图：输入 [{t, value}]，输出 SVG。够用就好，不引图表库。 */
function sparkSvg(points, { color = "#d7ff3e", unit = "", height = 132, label = "" } = {}) {
  const pts = (points || []).filter((p) => typeof p.value === "number" && Number.isFinite(p.value));
  if (pts.length < 2) return `<div class="empty" style="padding:18px">数据点不足（${pts.length}/2）</div>`;
  const w = 760;
  const h = height;
  const xMax = Math.max(...pts.map((p) => p.t)) || 1;
  const ys = pts.map((p) => p.value);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const span = yMax - yMin || Math.abs(yMax) * 0.1 || 1;
  const lo = yMin - span * 0.12;
  const hi = yMax + span * 0.12;
  const X = (t) => 40 + (t / xMax) * (w - 56);
  const Y = (v) => h - 22 - ((v - lo) / (hi - lo)) * (h - 40);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
  const area = `${d} L${X(pts[pts.length - 1].t).toFixed(1)},${h - 22} L${X(pts[0].t).toFixed(1)},${h - 22} Z`;
  const gridY = [0, 0.5, 1].map((f) => {
    const v = lo + (hi - lo) * (1 - f);
    const y = Y(v);
    return `<line x1="40" y1="${y.toFixed(1)}" x2="${w - 16}" y2="${y.toFixed(1)}" stroke="#1a2530" stroke-width="1"/>
            <text x="34" y="${(y + 3.5).toFixed(1)}" text-anchor="end" fill="#5d6d7c" font-size="10" font-family="monospace">${Math.round(v)}</text>`;
  });
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block" role="img" aria-label="${esc(label)}">
    ${gridY.join("")}
    <path d="${area}" fill="url(#${gid})" opacity="0.5"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(pts[pts.length - 1].t).toFixed(1)}" cy="${Y(pts[pts.length - 1].value).toFixed(1)}" r="3" fill="${color}"/>
    <text x="40" y="${h - 6}" fill="#5d6d7c" font-size="10" font-family="monospace">0s</text>
    <text x="${w - 16}" y="${h - 6}" text-anchor="end" fill="#5d6d7c" font-size="10" font-family="monospace">${Math.round(xMax)}s</text>
    <text x="${w - 16}" y="14" text-anchor="end" fill="#8b9aa9" font-size="11" font-family="monospace">${Math.round(yMax)}${esc(unit)}</text>
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
  </svg>`;
}

/* ---------------- home ---------------- */
function stageRow(stage, index, run) {
  const key = stage.key;
  const ev = (run?.events || []).filter((e) => e.stage === key && e.type === "stage").at(-1);
  const status = ev?.status || (run?.status === "running" && run.stage === key ? "start" : "pending");
  const isRunning = status === "start" || status === "running";
  const isDone = status === "done";
  const isErr = status === "error";
  const mark = isRunning
    ? `<span class="spinner"></span>`
    : isDone
      ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.2 12 13 4.5" stroke="#57c1ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : isErr
        ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="#ff6b5e" stroke-width="2" stroke-linecap="round"/></svg>`
        : `<span class="faint">·</span>`;
  return `<div class="stage ${isRunning ? "is-running" : isDone ? "is-done" : isErr ? "is-error" : ""}">
    <span class="stage-idx">${String(index + 1).padStart(2, "0")}</span>
    <span class="stage-state">${mark}</span>
    <span class="stage-name">${esc(stage.label)}</span>
    <span class="stage-hint">${esc(stage.hint || "")}</span>
    <span class="stage-ms">${isDone && ev?.ms ? `${(ev.ms / 1000).toFixed(1)}s` : ""}</span>
  </div>`;
}

function homeView() {
  const boot = state.boot;
  const run = state.run || boot?.run;
  const deepRunning = run?.status === "running" && run?.kind === "deep";
  const running = run?.status === "running" && run?.kind !== "deep";
  const last = (boot?.history || [])[0];
  const lastFull = state.result && state.result.id === last?.id ? state.result : null;
  const doneCount = (run?.events || []).filter((e) => e.type === "stage" && e.status === "done").length;
  const total = boot?.stages?.length || 6;
  const pct = running ? Math.round((doneCount / total) * 100) : run?.status === "done" ? 100 : 0;

  const hw = boot?.hardware?.hardware || {};
  const base = boot?.baseline || {};

 const heroCard = deepRunning
    ? (() => {
        const p = run.progress || {};
        const burned = p.burnedSec || 0;
        const dur = p.durationSec || state.deep.durationSec || 600;
        const pctDone = Math.min(100, (burned / Math.max(1, dur)) * 100);
        const live = run.live || {};
        const tempPoints = state.deep.liveSeries.map((s) => ({ t: s.t, value: s.cpuC }));
        return `<div class="card">
          <div class="card-head"><h2>正在烤机</h2><span class="sub">满载中，页面可以放着不管</span><span class="spacer"></span>
            <button class="btn sm ghost" data-action="cancel-run">中止</button>
          </div>
          <div class="row" style="align-items:baseline;gap:10px">
            <div class="score-num" style="font-size:34px">${fmtClock(burned)} <small>/ ${fmtClock(dur)}</small></div>
            <span class="spacer"></span>
            ${live.cpuC !== null && live.cpuC !== undefined ? `<span class="pill ${live.cpuC >= 90 ? "bad" : live.cpuC >= 80 ? "warn" : "good"}">${num(live.cpuC, 1)}°C</span>` : ""}
            ${live.freqMhz ? `<span class="pill">${num(live.freqMhz)} MHz</span>` : ""}
          </div>
          <div class="progress"><i style="width:${pctDone}%"></i></div>
          <div class="section-title" style="margin-top:16px">温度曲线（实时）</div>
          ${sparkSvg(tempPoints, { unit: "°C", height: 150, label: "实时温度曲线" })}
          <div class="faint" style="font-size:12px;margin-top:8px">
            烤机结束后会再做一次多核跑分，用来算"满载后还剩多少性能"。
          </div>
        </div>`;
      })()
    : running
    ? `<div class="card">
        ${run?.stage ? "" : ""}
        <div class="card-head"><h2>正在体检</h2><span class="sub">别关页面，也别在这期间跑转码</span><span class="spacer"></span>
          <button class="btn sm ghost" data-action="cancel-run">中止</button>
        </div>
        <div class="score-num" style="font-size:34px">${String(doneCount).padStart(2, "0")} <small>/ ${total} 项完成</small></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="stage-list" style="margin-top:16px">${(boot.stages || []).map((s, i) => stageRow(s, i, run)).join("")}</div>
      </div>`
    : `<div class="card">
        <div class="hero">
          <div class="hero-main">
            <div class="row" style="gap:12px">
              <div class="score-num">${last ? num(last.composite) : "—"}<small>综合分</small></div>
              ${last ? gradeBadge(last.grade) : `<span class="pill">还没测过</span>`}
            </div>
            <div class="score-sub">
              ${
                last
                  ? `最近一次：${new Date(last.ts).toLocaleString("zh-CN", { hour12: false })} · 单核 ${num(last.dims?.cpu?.score)} / 存储 ${num(last.dims?.storage?.score)}`
                  : "约 40 秒，跑 6 项，给这台机器出一份能拿去比的体检报告。"
              }
            </div>
            <div class="row" style="margin-top:18px">
              <button class="btn primary" data-action="start-run">${last ? "再测一次" : "开始体检"}</button>
              ${last ? `<button class="btn ghost" data-action="open-result" data-id="${esc(last.id)}">查看报告</button>` : ""}
            </div>
            ${
              boot?.settings?.autoSubmit && boot?.settings?.leaderboardUrl
                ? `<div class="faint" style="margin-top:10px;font-size:12px">测完会自动提交到天梯（设置里可关）</div>`
                : ""
            }
          </div>
          ${gaugeSvg(last?.composite || 0)}
        </div>
        ${
          last
            ? `<div class="divider"></div>
               ${Object.entries(boot.dimensions || {})
                 .map(([k, d]) => dimBlock(k, d, last.dims?.[k]))
                 .join("")}`
            : ""
        }
      </div>`;

  const hwCard = `<div class="card tight">
      <div class="card-head"><h2>这台机器</h2><span class="sub">用于天梯匹配</span></div>
      <dl class="kv">
        <dt>CPU</dt><dd>${esc(hw.cpu_model || "—")}</dd>
        <dt>核心</dt><dd>${hw.cores || "—"} 核 / ${hw.threads || "—"} 线程</dd>
        <dt>内存</dt><dd>${hw.mem_gb || "—"} GB</dd>
        <dt>显卡</dt><dd>${esc(hw.gpu || "未识别")}</dd>
        <dt>系统</dt><dd>fnOS ${esc(hw.os_version || "—")}</dd>
        <dt>测试卷</dt><dd class="mono truncate">${esc(hw.volume || boot?.settings?.targetDir || "—")}</dd>
      </dl>
      <div class="divider"></div>
      <div class="section-title">温度快照</div>
      <div class="tag-list">
        ${
          (boot?.hardware?.thermals || []).length
            ? boot.hardware.thermals
                .slice(0, 4)
                .map((t) => `<span class="pill">${esc(t.type)} ${num(t.celsius, 1)}°C</span>`)
                .join("")
            : `<span class="pill warn">未读到传感器</span>`
        }
      </div>
      <div class="divider"></div>
      <div class="section-title">基准</div>
      <div class="faint" style="font-size:12px">
        1000 分 = ${esc(base.machine?.cpu_model || "基准机")}（${esc(base.machine?.threads || "?")} 线程）
        ${base.measured_at ? ` · ${new Date(base.measured_at).toLocaleDateString("zh-CN")}` : ""}
      </div>
    </div>`;

  const whyCard = `<div class="card tight">
      <div class="card-head"><h2>测什么，不测什么</h2></div>
      <div class="faint" style="font-size:12.5px;line-height:1.75">
        测：CPU 单核/多核、AES 与 zlib 真实吞吐、内存带宽与延迟、磁盘顺序读写、4K 随机读写（O_DIRECT，绕过缓存）。<br/>
        不测：显卡编解码、网络吞吐、功耗与噪音 —— 这些得靠实测环境，跑分软件替代不了。
      </div>
      <div class="divider"></div>
      <div class="faint" style="font-size:12.5px">
        磁盘测试会在测试卷上临时写 512MB 文件，结束自动删除。测试期间 CPU 会跑满约 40 秒。
      </div>
    </div>`;

  const lastDeep = boot?.lastDeep;
  const deepPresets = [180, 300, 600, 1200];
  const deepCard = `<div class="card">
      <div class="card-head">
        <h2>深度体检 · 散热与降频</h2>
        <span class="sub">满载跑一段时间，看还能剩多少性能</span>
        <span class="spacer"></span>
        ${lastDeep ? verdictPill(lastDeep.verdictLevel, lastDeep.verdict) : ""}
      </div>
      ${
        lastDeep
          ? `<div class="row" style="gap:14px;flex-wrap:wrap;margin-bottom:14px">
              <span class="faint" style="font-size:12px">上次：${new Date(lastDeep.ts).toLocaleString("zh-CN", { hour12: false })}</span>
              ${lastDeep.maxTempC ? `<span class="pill">最高 ${num(lastDeep.maxTempC, 1)}°C</span>` : ""}
              <button class="btn sm ghost" data-action="open-result" data-id="${esc(lastDeep.id)}">看报告</button>
            </div>`
          : ""
      }
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:12px">
        ${deepPresets
          .map(
            (sec) =>
              `<button class="btn sm ${state.deep.durationSec === sec ? "primary" : "ghost"}" data-action="deep-duration" data-sec="${sec}">${sec / 60} 分钟</button>`,
          )
          .join("")}
      </div>
      <label class="check" style="margin-bottom:14px">
        <input type="checkbox" id="deep-disk" ${state.deep.loadDisk ? "checked" : ""} />
        叠加磁盘写压力（更接近 RAID 重建时的机箱温度，但会磨损 SSD）
      </label>
      <div class="row">
        <button class="btn ${deepRunning ? "" : "primary"}" data-action="start-deep" ${deepRunning ? "disabled" : ""}>开始深度体检</button>
        <span class="faint" style="font-size:12px">会满载 ${state.deep.durationSec / 60} 分钟，建议在没人用的时候跑</span>
      </div>
      <div class="hint-box" style="margin-top:12px">
        结论只看「满载前后的性能保持率」——这才是降频的真实代价。温度与频率作为旁证一起给你看。
      </div>
    </div>`;

  return `<div class="grid-2">
    <div class="stack">${heroCard}
      <div class="grid-3">
        ${Object.entries(boot?.dimensions || {})
          .map(([k, d]) => {
            const sc = last?.dims?.[k]?.score;
            return `<div class="card tight">
              <div class="faint" style="font-size:11.5px;letter-spacing:.08em;text-transform:uppercase">${esc(d.label)}</div>
              <div class="mono" style="font-size:26px;margin-top:6px">${sc === null || sc === undefined ? "—" : num(sc)}</div>
              <div class="bar ${k === "cpu" ? "" : k === "memory" ? "blue" : "violet"}"><i style="width:${sc ? Math.min(100, (sc / 1600) * 100) : 0}%"></i></div>
            </div>`;
          })
          .join("")}
      </div>
      ${deepCard}
    </div>
    <div class="stack">${hwCard}${whyCard}</div>
  </div>`;
}

/** 深度档报告：结论 + 三块关键数据 + 两条曲线 */
function deepResultView(r) {
  const s = r.stability || {};
  const v = s.verdict || {};
  const tempSeries = (r.series || []).map((p) => ({ t: p.t, value: p.cpuC }));
  const freqSeries = (r.series || []).map((p) => ({ t: p.t, value: p.freqMhz }));

  const cell = (label, value, hint = "") =>
    `<div style="padding:10px 0;border-bottom:1px dashed var(--line-soft)">
       <div class="faint" style="font-size:11.5px">${esc(label)}</div>
       <div class="mono" style="font-size:19px">${value}</div>
       ${hint ? `<div class="faint" style="font-size:11px">${esc(hint)}</div>` : ""}
     </div>`;

  return `<div class="stack">
    <div class="row">
      <button class="btn sm ghost" data-action="back">← 返回</button>
      <span class="spacer"></span>
      <span class="faint" style="font-size:12px">套件 v${esc(r.suite)} · ${new Date(r.ts).toLocaleString("zh-CN", { hour12: false })}</span>
    </div>

    <div class="card">
      <div class="row" style="gap:12px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:20px">${esc(v.headline || "稳定性报告")}</h2>
        ${verdictPill(v.level, s.cancelled ? "已中止" : "")}
        <span class="spacer"></span>
        <span class="pill">满载 ${(r.burnedSec || 0) < 90 ? `${Math.round(r.burnedSec || 0)} 秒` : `${Math.round((r.burnedSec || 0) / 60)} 分钟`}${r.loadDisk ? " · 含磁盘压力" : ""}</span>
      </div>
      <div class="score-sub" style="margin-top:8px">${esc(v.detail || "")}</div>
      <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
        <a class="btn" href="/api/results/${esc(r.id)}/report.md" target="_blank" rel="noreferrer">Markdown 报告</a>
        <a class="btn ghost" href="/api/results/${esc(r.id)}/export.json">导出 JSON</a>
      </div>
    </div>

    <div class="grid-3">
      <div class="card tight">
        <div class="section-title">性能保持</div>
        ${s.perf ? cell("冷态多核", `${num(s.perf.preMops)} <span class="faint" style="font-size:12px">MOps/s</span>`) : `<div class="faint">未采集</div>`}
        ${s.perf ? cell("满载后多核", `${num(s.perf.postMops)} <span class="faint" style="font-size:12px">MOps/s</span>`) : ""}
        ${s.perf ? cell("保持率", `<span style="color:${s.perf.keepPct >= 97 ? "var(--lime)" : s.perf.keepPct >= 92 ? "var(--amber)" : "var(--red)"}">${num(s.perf.keepPct, 1)}%</span>`, `损失 ${num(s.perf.lossPct, 1)}%`) : ""}
      </div>
      <div class="card tight">
        <div class="section-title">温度</div>
        ${s.temp ? cell("起始 → 结束", `${num(s.temp.startC, 1)} → ${num(s.temp.endC, 1)} <span class="faint" style="font-size:12px">°C</span>`) : `<div class="faint">无传感器</div>`}
        ${s.temp ? cell("最高", `${num(s.temp.maxC, 1)} <span class="faint" style="font-size:12px">°C</span>`, `升温 ${num(s.temp.riseC, 1)}°C`) : ""}
        ${s.temp && s.temp.plateauSec !== null ? cell("到达 90% 稳态", `${s.temp.plateauSec}s`) : ""}
      </div>
      <div class="card tight">
        <div class="section-title">频率</div>
        ${s.freq ? cell("峰值 → 稳态", `${num(s.freq.peakMhz)} → ${num(s.freq.steadyMhz)} <span class="faint" style="font-size:12px">MHz</span>`) : `<div class="faint">无频率信息</div>`}
        ${s.freq && s.freq.nominalMhz ? cell("标称最高", `${num(s.freq.nominalMhz)} MHz`) : ""}
        ${s.freq && s.freq.dropPct !== null ? cell("频率下降", `${num(s.freq.dropPct, 1)}%`) : ""}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>温度曲线</h2><span class="sub">逐秒采样，降采样后保留峰值</span></div>
      ${sparkSvg(tempSeries, { color: "#ffb545", unit: "°C", height: 160, label: "温度曲线" })}
      <div class="divider"></div>
      <div class="card-head"><h2>频率曲线</h2><span class="sub">降频是否被功耗墙压住，一眼能看出来</span></div>
      ${sparkSvg(freqSeries, { color: "#57c1ff", unit: "MHz", height: 140, label: "频率曲线" })}
    </div>

    ${
      r.caveats?.length
        ? `<div class="card tight"><div class="section-title">说明</div><div class="faint" style="font-size:12.5px;line-height:1.8">${r.caveats
            .map((c) => `· ${esc(c)}`)
            .join("<br/>")}</div></div>`
        : ""
    }
  </div>`;
}

/* ---------------- result ---------------- */
function resultView() {
  const r = state.result;
  if (!r) return `<div class="empty"><h3>加载中…</h3></div>`;
  if ((r.kind || "fast") === "deep") return deepResultView(r);
  const s = r.scores;
  const dims = Object.entries(state.boot?.dimensions || {});
  const metrics = Object.entries(state.boot?.metrics || {});

  return `<div class="stack">
    <div class="row">
      <button class="btn sm ghost" data-action="back">← 返回</button>
      <span class="spacer"></span>
      <span class="faint" style="font-size:12px">套件 v${esc(r.suite)} · ${new Date(r.ts).toLocaleString("zh-CN", { hour12: false })}</span>
    </div>

    <div class="card">
      <div class="hero">
        <div class="hero-main">
          <div class="row" style="gap:12px">
            <div class="score-num">${num(s.composite)}<small>综合分</small></div>
            ${gradeBadge(r.grade?.grade || "D", r.grade?.label)}
            ${r.scores.partial ? `<span class="pill warn">部分项缺失</span>` : ""}
            ${r.submitted ? `<span class="pill good">已上天梯</span>` : ""}
          </div>
          <div class="score-sub">${esc(r.grade?.hint || "")}</div>
          <div class="row" style="margin-top:16px;gap:8px;flex-wrap:wrap">
            <button class="btn primary" data-action="submit-result" data-id="${esc(r.id)}">提交到天梯</button>
            <a class="btn" href="/api/results/${esc(r.id)}/report.md" target="_blank" rel="noreferrer">Markdown 报告</a>
            <button class="btn ghost" data-action="copy-card" data-id="${esc(r.id)}">复制成绩卡</button>
            <a class="btn ghost" href="/api/results/${esc(r.id)}/export.json">导出 JSON</a>
          </div>
        </div>
        ${gaugeSvg(s.composite)}
      </div>
      <div class="divider"></div>
      ${dims.map(([k, d]) => dimBlock(k, d, s.dims?.[k])).join("")}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h2>原始指标</h2><span class="sub">归一化分 = 实测 / 基准 × 1000</span></div>
        <table class="table">
          <thead><tr><th>指标</th><th class="num">实测</th><th class="num">归一化</th></tr></thead>
          <tbody>
            ${metrics
              .filter(([k]) => r.metrics[k] !== undefined)
              .map(([k, def]) => {
                const raw = r.metrics[k];
                const shown =
                  raw >= 1000 ? num(raw) : raw >= 10 ? num(raw, 1) : num(raw, 2);
                return `<tr><td>${esc(def.label)}</td><td class="num">${shown} <span class="faint">${esc(def.unit)}</span></td><td class="num">${s.subs[k] === undefined ? "—" : num(s.subs[k], 1)}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        ${
          r.detail?.scaling
            ? `<div class="hint-box" style="margin-top:14px">多核扩展效率 <b class="mono">${num(r.detail.scaling, 1)}%</b>（100% = 完美线性；开了超线程的机器通常 40–60%，因为两个逻辑核共享执行单元。这个数字看的是"多核有没有被功耗墙或内存带宽压住"）</div>`
            : ""
        }
      </div>

      <div class="card">
        <div class="card-head"><h2>硬件档案</h2></div>
        <dl class="kv">
          <dt>CPU</dt><dd>${esc(r.hardware.cpu_model)}</dd>
          <dt>核心</dt><dd>${r.hardware.cores} 核 / ${r.hardware.threads} 线程</dd>
          <dt>内存</dt><dd>${r.hardware.mem_gb} GB</dd>
          <dt>整机</dt><dd>${esc(r.hardware.board || "—")}</dd>
          <dt>显卡</dt><dd>${esc(r.hardware.gpu || "—")}</dd>
          <dt>系统</dt><dd>fnOS ${esc(r.hardware.os_version)} · ${esc(r.hardware.kernel)}</dd>
          <dt>测试卷</dt><dd class="mono">${esc(r.hardware.volume)}</dd>
          <dt>指纹</dt><dd class="mono faint">${esc(r.fingerprint)}</dd>
        </dl>
        ${r.caveats?.length ? `<div class="divider"></div><div class="section-title">测试说明</div><div class="faint" style="font-size:12px;line-height:1.7">${r.caveats.map((c) => `· ${esc(c)}`).join("<br/>")}</div>` : ""}
      </div>
    </div>
  </div>`;
}

/* ---------------- board ---------------- */
function boardView() {
  const b = state.boot?.leaderboard;
  const data = state.board.data;
  const dims = [
    ["overall", "综合"],
    ["cpu", "CPU"],
    ["memory", "内存"],
    ["storage", "存储"],
  ];

  const filters = `<div class="row" style="flex-wrap:wrap;gap:8px">
      <div class="row" style="gap:4px">
        ${dims.map(([k, label]) => `<button class="btn sm ${state.board.dim === k ? "primary" : "ghost"}" data-action="board-dim" data-dim="${k}">${label}</button>`).join("")}
      </div>
      <span class="spacer"></span>
      <select id="board-arch" style="width:auto">
        <option value="" ${state.board.arch === "" ? "selected" : ""}>全部架构</option>
        <option value="x64" ${state.board.arch === "x64" ? "selected" : ""}>x86_64</option>
        <option value="arm64" ${state.board.arch === "arm64" ? "selected" : ""}>ARM64</option>
      </select>
      <button class="btn sm ghost" data-action="board-refresh">刷新</button>
    </div>`;

  let body = "";
  if (!b?.configured) {
    body = `<div class="hint-box">
      <b>还没有接上排行榜。</b><br/>
      牛刀自带一个零依赖的自托管榜单服务，把它放在任意一台能跑 Node 的机器上（本机也行）：
      <div style="margin:8px 0 0"><code>node leaderboard/server.js --port 8790</code></div>
      然后在「设置 → 排行服务器」填 <code>http://你的地址:8790</code>，就能和别人比了。<br/>
      没有服务器时，下面是本机的历史成绩排名。
    </div>`;
  } else if (b.configured && b.ok === false) {
    body = `<div class="hint-box"><b class="pill bad">连不上</b> ${esc(b.error || "")}<br/>检查设置里的地址，或确认榜单服务在跑。</div>`;
  }

  if (!data) {
    body += `<div class="empty"><h3>${state.board.loading ? "载入中…" : "还没有数据"}</h3><div>点上面的「刷新」试试。</div></div>`;
  } else if (!data.entries?.length) {
    body += `<div class="empty"><h3>榜上还没有机器</h3><div>你会是第一个。</div></div>`;
  } else {
    const me = data.me;
    const gap = me && me.above && Number.isFinite(me.above.value) ? Math.max(0, me.above.value - me.value) : null;
    const hist = (() => {
      const buckets = data.buckets || {};
      const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
      if (keys.length < 2) return "";
      const max = Math.max(...keys.map((k) => buckets[k]));
      const mine = me ? Math.floor(me.value / 100) * 100 : null;
      return `<div class="section-title" style="margin-top:18px">人群分布（每 100 分一档）</div>
        <div class="hist" title="柱子越高代表这一档的机器越多；亮色是你所在的档">
          ${keys
            .map(
              (k) =>
                `<i class="${k === mine ? "on" : ""}" style="height:${Math.max(6, (buckets[k] / max) * 100)}%" title="${k}–${k + 99} 分 · ${buckets[k]} 台"></i>`,
            )
            .join("")}
        </div>
        <div class="row faint" style="font-size:11px;margin-top:4px"><span>${num(keys[0])} 分</span><span class="spacer"></span><span>${num(keys[keys.length - 1] + 99)} 分</span></div>`;
    })();
    body += `
      ${
        me && me.percentile !== undefined && me.percentile !== null
          ? `<div class="hint-box" style="margin-bottom:14px">
              你这台在 <b class="mono">${num(data.total)}</b> 台机器里排第 <b class="mono">${num(me.rank)}</b>，
              超过 <b class="mono">${num(me.percentile, 1)}%</b> 的机器。
              ${gap ? `<br/>离前一名还差 <b class="mono">${num(gap)}</b> 分。` : ""}
              ${me.above ? `<br/>前一名：${esc(me.above.alias || me.above.hardware?.cpu_model || "—")} · ${num(me.above.value)}` : `<br/>你就是榜一。`}
              ${me.below ? `<br/>后一名：${esc(me.below.alias || me.below.hardware?.cpu_model || "—")} · ${num(me.below.value)}` : ""}
            </div>`
          : ""
      }
      ${hist}
      <table class="table" style="margin-top:12px">
        <thead><tr><th class="rank-cell">#</th><th>机器</th><th class="num">分</th><th class="num">综合</th></tr></thead>
        <tbody>
          ${data.entries
            .map(
              (e) => `<tr class="${me && e.rank === me.rank ? "is-me" : ""}">
                <td class="rank-cell ${e.rank <= 3 ? "top" : ""}">${e.rank}</td>
                <td>
                  <div class="truncate">${esc(e.alias || (data.mode === "remote" ? e.hardware?.cpu_model || "匿名机器" : "本机 · " + (e.hardware?.cpu_model || "")))}</div>
                  <div class="faint" style="font-size:11.5px">${esc(e.hardware?.cpu_model || "")}${e.hardware?.mem_gb ? ` · ${e.hardware.mem_gb}GB` : ""}${e.arch ? ` · ${esc(e.arch)}` : ""}</div>
                </td>
                <td class="num">${num(e.value)}</td>
                <td class="num faint">${num(e.composite)}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>`;
  }

  return `<div class="stack">
    <div class="card">
      <div class="card-head"><h2>天梯</h2>
        <span class="sub">${data?.mode === "remote" ? "社区榜单" : "本机成绩"}</span>
        <span class="spacer"></span>
        ${data?.total ? `<span class="pill">${num(data.total)} 台机器</span>` : ""}
      </div>
      ${filters}
      <div class="divider"></div>
      ${body}
    </div>
    <div class="hint-box">
      榜单只接受本套件版本的原始指标，分数由服务端重算 —— 客户端改分数没有用。同一台机器（按硬件指纹）只保留最好的一次。
    </div>
  </div>`;
}

/* ---------------- history ---------------- */
function historyView() {
  const items = state.boot?.history || [];
  if (!items.length) {
    return `<div class="card"><div class="empty"><h3>还没有成绩单</h3><div>去「体检」跑一次。</div></div></div>`;
  }
  return `<div class="card">
    <div class="card-head"><h2>成绩单</h2><span class="sub">本机历史，最多显示 30 条</span></div>
    <table class="table">
      <thead><tr><th>时间</th><th>类型</th><th class="num">分数 / 结论</th><th class="num">CPU</th><th class="num">内存</th><th class="num">存储</th><th></th></tr></thead>
      <tbody>
        ${items
          .map((r) => {
            const isDeep = r.kind === "deep";
            return `<tr>
              <td class="nowrap">
                <button class="btn sm ghost" data-action="open-result" data-id="${esc(r.id)}">${new Date(r.ts).toLocaleString("zh-CN", { hour12: false })}</button>
                ${r.partial ? `<span class="pill warn">不完整</span>` : ""}
                ${r.submitted ? `<span class="pill good">已提交</span>` : ""}
              </td>
              <td>${isDeep ? `<span class="pill">稳定性</span>` : `<span class="pill good">性能</span>`}</td>
              <td class="num">${
                isDeep
                  ? `${verdictPill(r.verdictLevel, r.verdict)} ${r.maxTempC ? `<span class="faint">${num(r.maxTempC, 1)}°C</span>` : ""}`
                  : `<span class="mono">${num(r.composite)}</span> ${gradeBadge(r.grade)}`
              }</td>
              <td class="num">${isDeep ? "—" : num(r.dims?.cpu?.score)}</td>
              <td class="num">${isDeep ? "—" : num(r.dims?.memory?.score)}</td>
              <td class="num">${isDeep ? "—" : num(r.dims?.storage?.score)}</td>
              <td class="num"><button class="btn sm danger" data-action="delete-result" data-id="${esc(r.id)}">删除</button></td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </div>`;
}

/* ---------------- settings ---------------- */
function settingsView() {
  const s = state.boot?.settings || {};
  return `<div class="stack" style="max-width:720px">
    <div class="card">
      <div class="card-head"><h2>天梯</h2><span class="sub">自托管榜单，填地址即可接入</span></div>
      <div class="field">
        <label>排行榜地址</label>
        <input type="url" id="f-leaderboardUrl" placeholder="http://192.168.1.10:8790" value="${esc(s.leaderboardUrl || "")}" />
        <span class="hint">留空 = 只用本地成绩单。填好后点下面「测试连接」。</span>
      </div>
      <div class="field">
        <label>花名（榜单显示名）</label>
        <input type="text" id="f-alias" maxlength="16" placeholder="最多 16 个字，留空则显示 CPU 型号" value="${esc(s.alias || "")}" />
      </div>
      <div class="field">
        <label>提交令牌（可选）</label>
        <input type="password" id="f-leaderboardToken" placeholder="榜单服务设了 token 才需要填" value="${esc(s.leaderboardToken || "")}" />
      </div>
      <label class="check" style="margin-bottom:16px">
        <input type="checkbox" id="f-autoSubmit" ${s.autoSubmit ? "checked" : ""} />
        测完自动提交（不勾的话，测完手动点提交）
      </label>
      <div class="row">
        <button class="btn primary" data-action="save-settings">保存</button>
        <button class="btn ghost" data-action="test-conn">测试连接</button>
        <span class="spacer"></span>
        <span class="faint" id="conn-state" style="font-size:12px"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>测试</h2><span class="sub">磁盘测试文件写在哪个卷上</span></div>
      <div class="field">
        <label>测试目录</label>
        <input type="text" id="f-targetDir" list="volumes" value="${esc(s.targetDir || "")}" />
        <datalist id="volumes">
          ${(state.boot?.hardware?.hardware?.disks || [])
            .map((d) => String(d).split(" ")[0])
            .filter(Boolean)
            .map((m) => `<option value="${esc(m)}"></option>`)
            .join("")}
        </datalist>
        <span class="hint">默认是应用数据目录所在卷。想测别的盘，填一个有写权限的路径（下拉里是识别到的卷）。</span>
      </div>
      <div class="field">
        <label>顺序测试文件大小（MB）</label>
        <input type="number" id="f-diskSizeMb" min="64" max="4096" step="64" value="${esc(s.diskSizeMb || 512)}" />
      </div>
      <button class="btn" data-action="save-settings">保存</button>
    </div>

    <div class="card tight">
      <div class="card-head"><h2>关于</h2></div>
      <dl class="kv">
        <dt>版本</dt><dd class="mono">v${esc(state.boot?.client || "—")} · 套件 v${esc(state.boot?.suite || "—")}</dd>
        <dt>基准机</dt><dd>${esc(state.boot?.baseline?.machine?.cpu_model || "—")}</dd>
        <dt>数据</dt><dd class="faint">本机成绩存在应用数据目录（results.jsonl），删除应用前先导出。</dd>
      </dl>
    </div>
  </div>`;
}

/* ---------------- render ---------------- */
function render() {
  const view = state.view;
  const html =
    view === "result" ? resultView() : view === "board" ? boardView() : view === "history" ? historyView() : view === "settings" ? settingsView() : homeView();
  appEl().innerHTML = html;
  document.querySelectorAll("#tabs .tab").forEach((t) => {
    t.classList.toggle("is-active", t.dataset.view === (view === "result" ? "history" : view));
  });
  const label = state.boot?.hardware?.hardware;
  if (label) {
    $("#machine-label").textContent = `${label.cpu_model} · ${label.threads} 线程 · ${label.mem_gb}GB`;
  }
}

/* ---------------- actions ---------------- */
async function refreshBoot() {
  const boot = await api("/api/bootstrap");
  state.boot = boot;
  state.run = boot.run;
  render();
}

async function openResult(id) {
  state.result = await api(`/api/results/${id}`);
  state.resultId = id;
  state.view = "result";
  render();
}

async function startRun() {
  try {
    await api("/api/run", { method: "POST", body: JSON.stringify({}) });
    state.view = "home";
    toast("开始体检，约 40 秒");
    render();
    pollRun();
  } catch (e) {
    toast(e.message, "err");
  }
}

function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

async function startDeep() {
  try {
    await api("/api/deep/run", {
      method: "POST",
      body: JSON.stringify({ durationSec: state.deep.durationSec, loadDisk: state.deep.loadDisk }),
    });
    state.deep.liveSeries = [];
    state.view = "home";
    toast(`开始深度体检，满载 ${Math.round(state.deep.durationSec / 60)} 分钟`);
    render();
    pollRun();
  } catch (e) {
    toast(e.message, "err");
  }
}

function pollRun() {
  stopPolling();
  state.poll = setInterval(async () => {
    try {
      const run = await api("/api/run");
      // 深度档：把实时采样攒成曲线
      if (run.kind === "deep" && run.status === "running" && run.live && typeof run.live.cpuC === "number") {
        const last = state.deep.liveSeries.at(-1);
        if (!last || run.live.t > last.t) state.deep.liveSeries.push({ t: run.live.t, cpuC: run.live.cpuC });
      }
      state.run = run;
      render();
      if (run.status !== "running") {
        stopPolling();
        await refreshBoot();
        if ((run.status === "done" || run.status === "cancelled") && run.resultId) {
          await openResult(run.resultId);
          toast(run.status === "done" ? "体检完成" : "已中止，结果已保存", "ok");
        } else if (run.status === "error") {
          toast(`体检失败：${run.error || "未知错误"}`, "err");
        }
      }
    } catch (e) {
      stopPolling();
      toast(e.message, "err");
    }
  }, 900);
}

async function loadBoard() {
  state.board.loading = true;
  state.board.error = null;
  render();
  try {
    const q = new URLSearchParams({ dim: state.board.dim, limit: "50" });
    if (state.board.arch) q.set("arch", state.board.arch);
    state.board.data = await api(`/api/leaderboard?${q}`);
  } catch (e) {
    state.board.error = e.message;
    toast(e.message, "err");
  } finally {
    state.board.loading = false;
    render();
  }
}

async function saveSettings() {
  const patch = {
    leaderboardUrl: $("#f-leaderboardUrl")?.value.trim() || "",
    alias: $("#f-alias")?.value.trim() || "",
    leaderboardToken: $("#f-leaderboardToken")?.value || "",
    autoSubmit: Boolean($("#f-autoSubmit")?.checked),
  };
  const targetDir = $("#f-targetDir")?.value.trim();
  if (targetDir) patch.targetDir = targetDir;
  const disk = $("#f-diskSizeMb")?.value;
  if (disk) patch.diskSizeMb = Number(disk);
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify(patch) });
    toast("已保存", "ok");
    await refreshBoot();
  } catch (e) {
    toast(e.message, "err");
  }
}

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  if (action === "start-run") return startRun();
  if (action === "start-deep") return startDeep();
  if (action === "deep-duration") {
    state.deep.durationSec = Number(el.dataset.sec) || 600;
    return render();
  }
  if (action === "cancel-run") {
    await api("/api/run/cancel", { method: "POST" });
    toast("已请求中止，当前项跑完就停");
    return;
  }
  if (action === "open-result") return openResult(id);
  if (action === "back") {
    state.view = "home";
    return refreshBoot();
  }
  if (action === "save-settings") return saveSettings();
  if (action === "test-conn") {
    try {
      const res = await api("/api/leaderboard?dim=overall&limit=1");
      const el2 = $("#conn-state");
      if (el2) el2.textContent = `连接正常（${res.mode === "remote" ? "远程榜单" : "本地模式"}，共 ${num(res.total)} 条）`;
      toast("连接正常", "ok");
    } catch (e) {
      toast(`连不上：${e.message}`, "err");
    }
    return;
  }
  if (action === "board-dim") {
    state.board.dim = el.dataset.dim;
    return loadBoard();
  }
  if (action === "board-refresh") return loadBoard();
  if (action === "submit-result") {
    try {
      await api(`/api/results/${id}/submit`, { method: "POST", body: JSON.stringify({}) });
      toast("已提交到天梯", "ok");
      state.result = await api(`/api/results/${id}`);
      await refreshBoot();
    } catch (e) {
      toast(e.message, "err");
    }
    return;
  }
  if (action === "copy-card") {
    try {
      const { text } = await api(`/api/results/${id}/card`);
      await navigator.clipboard.writeText(text);
      toast("成绩卡已复制", "ok");
    } catch {
      toast("复制失败，可以手动导出 Markdown", "err");
    }
    return;
  }
  if (action === "delete-result") {
    if (!confirm("删除这条成绩？")) return;
    await api(`/api/results/${id}`, { method: "DELETE" });
    toast("已删除");
    if (state.view === "result") state.view = "history";
    return refreshBoot();
  }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "board-arch") {
    state.board.arch = ev.target.value;
    loadBoard();
  }
  if (ev.target.id === "deep-disk") {
    state.deep.loadDisk = ev.target.checked;
  }
});

document.querySelectorAll("#tabs .tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    state.view = tab.dataset.view;
    if (state.view === "board") return loadBoard();
    if (state.view !== "result") await refreshBoot();
    else render();
  });
});

(async () => {
  try {
    await refreshBoot();
    if (state.run?.status === "running") pollRun();
  } catch (e) {
    appEl().innerHTML = `<div class="empty"><h3>加载失败</h3><div>${esc(e.message)}</div></div>`;
  }
})();
