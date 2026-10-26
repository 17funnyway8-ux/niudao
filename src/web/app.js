/* 牛刀前端：零框架、零依赖，全部视图用原生 DOM 拼装。 */
import { bindChartHover, lineChart, roundBars } from "./js/chart.js";
import { openFeedback } from "./feedback.js";

const $ = (sel, root = document) => root.querySelector(sel);

/* 主题：跟随系统，可手动覆盖（记在 localStorage） */
const THEME_KEY = "niudao.theme";
function applyTheme(mode) {
  const sys = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = mode || localStorage.getItem(THEME_KEY) || sys;
}
applyTheme();

// 前端异常留个尾巴：用户点"反馈"时能一并带上，不用靠回忆
const clientErrors = [];
window.addEventListener("error", (ev) => {
  clientErrors.push(`${new Date().toISOString()} ${ev.message} @ ${ev.filename}:${ev.lineno}`);
  if (clientErrors.length > 20) clientErrors.shift();
});
window.addEventListener("unhandledrejection", (ev) => {
  clientErrors.push(`${new Date().toISOString()} unhandled: ${ev.reason?.message || ev.reason}`);
  if (clientErrors.length > 20) clientErrors.shift();
});
document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  document.documentElement.dataset.theme = next;
});
import qrcode from "./vendor-qrcode.js";

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
  verdict: null,
  verdictLoading: false,
  showMetrics: true,
  run: null,
  poll: null,
  board: { dim: "overall", arch: "", cpuOnly: false, track: "physical", data: null, loading: false, error: null },
  deep: { durationSec: 300, loadDisk: false, liveSeries: [], clockAt: 0 },
  fast: { liveSeries: [] },
};

/* ---------------- api ---------------- */
// 所有接口都用**相对路径**：<base> 已经指向 /app/niudao/ 或 /，带前导斜杠会绕过它
const rel = (p) => String(p).replace(/^\/+/, "");

/**
 * 公众号合集。manifest 的 distributor_url 是同一份地址（两处要保持一致，
 * 由 test/version.test.js 校验）。放这里是为了在应用内也能生成二维码。
 */
const MP_BIZ = "MzkyOTcwMzE0MQ==";
/** 公众号主页：扫码直达，比"合集页"更符合"关注"的意图 */
const MP_HOME_URL = `https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=${MP_BIZ}`;
/** 合集的完整地址（manifest 里 distributor_url 用的是它） */
const MP_ALBUM_URL = `https://mp.weixin.qq.com/mp/appmsgalbum?__biz=${MP_BIZ}&action=getalbum&album_id=4707355291124957184`;
const MP_NAME = "家有飞牛Fun";

async function api(path, opts = {}) {
  const res = await fetch(rel(path), {
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
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败 (${res.status})`);
    err.body = data; // 带上完整响应体：有些失败需要用它做回退（如 targetDir 的 fallback）
    throw err;
  }
  return data;
}

/**
 * 应用内确认弹窗。替代 window.confirm ——
 * 原生弹窗带着「10.1.1.26:5666 显示」这种域名标题，样式和应用完全不搭，
 * 一眼就能看出是网页而不是应用。
 * 返回 Promise<boolean>，用法：if (!(await ask("删除这条成绩？"))) return;
 */
function ask(message, { title = "确认", okText = "确定", cancelText = "取消", danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "modal-mask";
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escAttr(title)}">
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-ask="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-ask="ok">${esc(okText)}</button>
        </div>
      </div>`;
    const close = (val) => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    wrap.addEventListener("click", (e) => {
      const t = e.target.closest("[data-ask]")?.dataset.ask;
      if (t === "ok") close(true);
      else if (t === "cancel" || e.target === wrap) close(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-ask="cancel"]')?.focus();
  });
}

function escAttr(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * 公众号二维码。
 *
 * 只在「关于」里放一处：这是用户主动找"这软件谁做的、还有没有更多东西"的位置，
 * 属于预期之内。首屏/弹窗/成绩卡里都不放 —— 那是把测量工具变成营销物料的地方。
 * 桌面浏览器里手机扫屏幕，120px 偏小，所以点一下能放大到 260px。
 */
function mpQrCode(size = 120) {
  let q;
  try {
    q = qrcode(0, "M");
    q.addData(MP_HOME_URL);
    q.make();
  } catch {
    return `<div class="qr-fallback">二维码生成失败，可直接访问<br/><span class="mono">${esc(MP_ALBUM_URL)}</span></div>`;
  }
  const n = q.getModuleCount();
  let path = "";
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    }
  }
  return `<button class="qr-btn" data-action="zoom-qr" title="点击放大">
      <svg class="qr-svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-label="公众号二维码">
        <rect width="${n}" height="${n}" fill="#fff"/>
        <path d="${path}" fill="#0b0f14"/>
      </svg>
    </button>`;
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

function gradeBadge(grade) {
  const g = grade || "D";
  return `<span class="grade ${esc(g)}">${esc(g)} 级</span>`;
}

function dimBlock(key, dim, data) {
  const score = data?.score;
  const cls = key === "cpu" ? "" : key === "memory" ? "blue" : "violet";
  const pct = score ? Math.max(2, Math.min(100, (score / 1600) * 100)) : 0;
  const weight = Math.round((dim.weight || 0) * 100);
  return `<div class="dim">
    <span class="dim-name" title="权重 ${weight}%">${esc(dim.label)}</span>
    <span class="bar"><i style="width:${pct}%"></i></span>
    <span class="dim-score">${score === null || score === undefined ? "—" : num(score)}</span>
  </div>`;
}

const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** 每项的测法，直接来自该次运行的 detail，不写死 */
function howMeasured(r, key) {
  const d = r.detail || {};
  const threads = d.cpu_multi?.threads || r.hardware?.threads || "?";
  const map = {
    cpu_single: `2 轮 × ${Math.round((r.durations?.cpu_single || 10000) / 2000)}s${coreHint(r)}${clockHint(r)}`,
    cpu_multi: `${threads} 线程 × ${Math.round((r.durations?.cpu_multi || 5000) / 1000)}s${clockHint(r)}`,
    crypto_aes: `GCM ${d.crypto?.totalMb || "—"}MB / ${d.crypto?.chunkMb || "—"}MB 块`,
    zlib: `deflate L${d.crypto?.level || 6} ${d.crypto?.sizeMb || "—"}MB（压缩率 ${d.crypto?.ratio ?? "—"}）`,
    mem_copy: `${d.memory?.bytesMb || "—"}MB 拷贝 × ${d.memory?.reps || "—"}`,
    mem_latency: `${d.memory?.sizeMb || "—"}MB 随机环 / ${((d.memory?.steps || 0) / 1e6).toFixed(0) || "—"}M 步`,
    disk_seq_read: `${d.disk_seq?.sizeMb || "—"}MB O_DIRECT${d.disk_seq?.direct === false ? "（退化）" : ""}`,
    disk_seq_write: `${d.disk_seq?.sizeMb || "—"}MB O_DIRECT${d.disk_seq?.direct === false ? "（退化）" : ""}`,
    disk_rand_read: `4K QD1 / ${d.disk_random?.fileMb || "—"}MB 文件 / ${((d.disk_random?.readLatUs || 0) / 1000).toFixed(2) || "—"}ms`,
    disk_rand_write: `4K QD1 / ${d.disk_random?.fileMb || "—"}MB 文件`,
  };
  return map[key] || "—";
}

/**
 * 测试期间 CPU 的工作频率。同型号 CPU 开不开睿频、功耗墙设多少，
 * 结果能差 30% 以上 —— 不写这个，看榜的人只会以为"同一颗 U 有人虚标"。
 */
/** 卷的一行说明：/vol1 · btrfs · 1788GB（可用 1079GB）· SSD 型号 */
function volLabel(v) {
  const size = v.size_gb ? `${v.size_gb}GB` : "";
  const free = Number.isFinite(v.free_gb) ? `（可用 ${v.free_gb}GB）` : "";
  const auth = v.authorized ? (v.writable ? "已授权·可写" : "已授权·只读") : "";
  const parts = [auth, v.fstype, size + free, v.kind, v.disks > 1 ? `${v.disks} 块盘` : ""];
  return parts.filter(Boolean).join(" · ");
}

/**
 * 单核跑在哪个核上。混合架构（Intel P/E 核）上这不是细节：
 * 落到 E 核分数会腰斩，看不出这件事就会误判"这台机器很慢"。
 */
/** 触顶项的说明：告诉用户"这个数不是机器强，是测量被缓存放大了" */
function cappedTitle(r) {
  const capped = r?.scores?.capped || [];
  if (!capped.length) return "";
  const names = capped.map((k) => state.boot?.metrics?.[k]?.label || k);
  return `${names.join("、")} 超过真实硬件的物理上限（多半是虚拟机/页缓存把数放大了），这几项已按上限计分`;
}

/** 运行环境：物理机还是虚拟机。虚机还要写明是哪种虚拟化，以及判定依据 */
function envCell(r) {
  const env = r.envInfo || r.env || (r.envType ? { type: r.envType, tech: r.vmTech } : null);
  if (!env || env.type === "physical" || !env.type) return `<span class="pill good">物理机</span>`;
  const label = env.type === "container" ? "容器" : "虚拟机";
  const tech = env.tech ? ` · ${esc(env.tech)}` : "";
  const why = (env.evidence || []).length ? ` title="判定依据：${esc((env.evidence || []).join("；"))}"` : "";
  return `<span class="pill warn"${why}>${label}${tech}</span>`;
}

function coreHint(r) {
  const d = r?.detail?.cpu_single;
  if (!d) return "";
  if (Number.isFinite(d.pinnedCpu)) return ` · 钉在 P 核 #${d.pinnedCpu}`;
  if (Number.isFinite(d.spreadPct) && d.spreadPct > 12) return ` · 两轮波动 ${d.spreadPct}%`;
  return "";
}

function clockHint(r) {
  const c = r?.detail?.cpuClock;
  if (!c || !c.available) return "";
  if (Number.isFinite(c.singlePeakMhz)) return ` · 单核峰值 ${num(c.singlePeakMhz)}MHz`;
  return Number.isFinite(c.maxMhz) ? ` · 峰值 ${num(c.maxMhz)}MHz` : "";
}

function clockCell(r) {
  const c = r?.detail?.cpuClock;
  if (!c || !c.available) return `<span class="faint">未读到这里</span>`;
  // 单核看峰值、全核看平均 —— 混在一起报会让人以为"单核频率上不去"
  const parts = [];
  if (Number.isFinite(c.singlePeakMhz)) parts.push(`单核 <span class="mono">${num(c.singlePeakMhz)}</span> MHz`);
  if (Number.isFinite(c.allCoreAvgMhz)) parts.push(`全核 <span class="mono">${num(c.allCoreAvgMhz)}</span> MHz`);
  if (!parts.length && Number.isFinite(c.maxMhz)) parts.push(`峰值 <span class="mono">${num(c.maxMhz)}</span> MHz`);
  const tail = Number.isFinite(c.sustainedPct) && c.sustainedPct < 95 ? ` <span class="faint">（全核为峰值的 ${c.sustainedPct}%）</span>` : "";
  return parts.join(" · ") + tail;
}

const VERDICT_TONE = { good: "good", ok: "warn", warn: "warn", bad: "bad", unknown: "" };

function verdictPill(level, headline) {
  if (!headline) return "";
  return `<span class="pill ${VERDICT_TONE[level] || ""}">${esc(headline)}</span>`;
}

/* ---------------- home ---------------- */
/** 跑分时的实时数值面板：让"在跑"这件事看得见，而不只是进度条在动 */
function livePanel(run) {
  const live = run?.live || {};
  const rows = [];
  if (live.cpuMulti?.mops) {
    rows.push(`<div class="live-metric"><span class="live-value">${num(live.cpuMulti.mops)}</span><span class="live-unit">MOps/s</span><span class="live-label">多核吞吐</span></div>`);
  }
  if (live.diskSeq?.mbs) {
    rows.push(`<div class="live-metric"><span class="live-value">${num(live.diskSeq.mbs, 1)}</span><span class="live-unit">MB/s</span><span class="live-label">顺序${live.diskSeq.phase === "read" ? "读" : "写"}</span></div>`);
  }
  if (live.diskRandom?.iops) {
    rows.push(`<div class="live-metric"><span class="live-value">${num(live.diskRandom.iops)}</span><span class="live-unit">IOPS</span><span class="live-label">4K 随机${live.diskRandom.progress === "read" ? "读" : "写"}</span></div>`);
  }
  const temp = live.temp;
  if (temp && (temp.cpuC !== null && temp.cpuC !== undefined)) {
    rows.push(`<div class="live-metric"><span class="live-value ${temp.cpuC >= 90 ? "is-warn" : ""}">${num(temp.cpuC, 1)}</span><span class="live-unit">°C</span><span class="live-label">CPU 温度</span></div>`);
  }
  // 频率：单核阶段必须看**跑测试的那一个核**，不能取所有核平均。
  // 单核跑满 2.0GHz 时，其余 15 个核空闲在 1.4GHz，平均下来只有 1.5GHz ——
  // 用户看到会以为"频率没跑上去"，其实是口径问题（这个坑踩过一次）。
  if (temp && (temp.freqMaxMhz || temp.freqMhz)) {
    const single = run?.live?.stage === "cpu_single";
    const mhz = single ? temp.freqMaxMhz || temp.freqMhz : temp.freqMhz || temp.freqMaxMhz;
    const label = single ? "单核频率" : "全核平均频率";
    rows.push(`<div class="live-metric"><span class="live-value">${num(mhz)}</span><span class="live-unit">MHz</span><span class="live-label">${label}</span></div>`);
  }
  if (!rows.length) return "";
  return `<div class="live-panel">${rows.join("")}</div>`;
}

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
  // 首页摘要只看快速档（深度档没有综合分）
  const last = (boot?.history || []).find((r) => r.kind !== "deep") || null;
  const lastFull = state.result && state.result.id === last?.id ? state.result : null;
  const doneCount = (run?.events || []).filter((e) => e.type === "stage" && e.status === "done").length;
  const total = boot?.stages?.length || 6;
  const pct = running ? Math.round((doneCount / total) * 100) : run?.status === "done" ? 100 : 0;

  const hw = boot?.hardware?.hardware || {};
  const base = boot?.baseline || {};

 const heroCard = deepRunning
    ? (() => {
        const p = run.progress || {};
        const dur = p.durationSec || state.deep.durationSec || 600;
        // 本地跑秒表：只把服务端的 burnedSec 当基准点，之后用本地时间递推。
        // 服务端 tick 与前端轮询都对不齐的话，秒表会一顿一顿地跳（甚至卡好几秒），
        // 而"正在烤机"这件事最需要的就是"它在动"的确定感。
        const baseBurn = p.burnedSec || 0;
        const drift = state.deep.clockAt ? (Date.now() - state.deep.clockAt) / 1000 : 0;
        const burned = Math.min(dur, baseBurn + (p.phase === "burn" ? drift : 0));
        const pctDone = Math.min(100, (burned / Math.max(1, dur)) * 100);
        const live = run.live || {};
        // 烤机前的冷态基线复测要十几秒，这段时间秒表本来就该是 0 —— 但得说清在干什么
        const warming = p.phase !== "burn" && baseBurn === 0;
        const tempPoints = state.deep.liveSeries.map((s) => ({ t: s.t, value: s.cpuC }));
        return `<div class="card">
          <div class="card-head"><h2>${warming ? "准备中" : "正在烤机"}</h2><span class="sub">${warming ? "先测一次冷态基线，马上开始满载" : "满载中，页面可以放着不管"}</span><span class="spacer"></span>
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
          ${lineChart(tempPoints, { unit: "°C", height: 150, label: "实时温度曲线", id: "live-temp", threshold: 90, thresholdLabel: "90°C 警示" })}
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
          <button class="btn sm ghost" data-action="feedback" title="卡住了？把现场发我">卡住了？</button>
        </div>
        <div class="score-num" style="font-size:34px">${String(doneCount).padStart(2, "0")} <small>/ ${total} 项完成</small></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        ${livePanel(run)}
        ${(() => {
          const points = (state.fast.liveSeries || []).map((p) => ({ t: p.t, value: p.cpuC }));
          return points.length > 2 ? lineChart(points, { unit: "°C", height: 130, label: "温度（实时）", id: "live-temp-fast", threshold: 90, thresholdLabel: "90°C" }) : "";
        })()}
        <div class="stage-list" style="margin-top:16px">${(boot.stages || []).map((s, i) => stageRow(s, i, run)).join("")}</div>
      </div>`
    : `<div class="card">
        <div class="card-head">
          <h2>最近一次体检</h2>
          <span class="sub">${last ? new Date(last.ts).toLocaleString("zh-CN", { hour12: false }) : "尚未测量"}</span>
          <span class="spacer"></span>
          ${last ? gradeBadge(last.grade) : ""}
        </div>
        <div class="score-row">
          <div class="score-num is-score">${last ? num(last.composite) : "—"}<small>综合分</small></div>
          <div class="score-meta">
            ${
              last
                ? `<span class="score-sub">CPU ${num(last.dims?.cpu?.score)} · 内存 ${num(last.dims?.memory?.score)} · 存储 ${num(last.dims?.storage?.score)}</span>
                   <span class="faint" style="font-size:11.5px">套件 v${esc(last.suite || boot?.suite || "—")} · 基准 1,000</span>`
                : `<span class="score-sub">六项实测，约 40 秒；结果可导出报告并提交到天梯。</span>`
            }
          </div>
          <span class="spacer"></span>
          <div class="row">
            <button class="btn primary" data-action="start-run" title="${last ? "再测一次，只保留最好成绩" : "约 40 秒出一份完整体检"}">${last ? "再试牛刀" : "小试牛刀"}</button>
            ${last ? `<button class="btn" data-action="open-result" data-id="${esc(last.id)}">打开报告</button>` : ""}
          </div>
        </div>
        ${
          last
            ? `<div class="divider"></div>
               ${Object.entries(boot.dimensions || {})
                 .map(([k, d]) => dimBlock(k, d, last.dims?.[k]))
                 .join("")}`
            : ""
        }
        ${
          boot?.settings?.autoSubmit && boot?.settings?.leaderboardUrl
            ? `<div class="notice" style="margin-top:12px">测完会自动提交到天梯（可在设置中关闭）。</div>`
            : ""
        }
      </div>`;

  const hwCard = `<div class="card tight">
      <div class="card-head"><h2>硬件</h2><span class="sub">天梯按此匹配</span></div>
      <dl class="kv">
        <dt>运行环境</dt><dd>${envCell({ envInfo: boot?.hardware?.env })}</dd>
        <dt>CPU</dt><dd>${esc(hw.cpu_model || "—")}</dd>
        <dt>核心</dt><dd>${hw.cores || "—"} 核 / ${hw.threads || "—"} 线程</dd>
        <dt>内存</dt><dd>${hw.mem_gb || "—"} GB${hw.mem_gib ? ` <span class="faint">（系统可见 ${hw.mem_gib} GiB）</span>` : ""}</dd>
        <dt>显卡</dt><dd>${esc(hw.gpu || "未识别")}</dd>
        <dt>系统</dt><dd>fnOS ${esc(hw.os_version || "—")}</dd>
        <dt>测试卷</dt><dd class="vol-cell">${
          // 路径要完整可见：用户常常在几个卷之间切着测，路径被截断就没法核对是哪块盘
          (() => {
            const path = String(hw.volume || boot?.settings?.targetDir || "—");
            // 找最匹配的卷：优先完全一致，其次是最长的父路径
            const vols = (boot?.hardware?.volumes || []).filter((x) => x?.mount);
            const v =
              vols.find((x) => x.mount === path) ||
              vols
                .filter((x) => path.startsWith(`${x.mount}/`))
                .sort((a, b) => b.mount.length - a.mount.length)[0];
            const detail = v
              ? `<span class="vol-meta">${esc(v.authorized ? (v.writable ? "已授权·可写" : "已授权·只读") : "")}${v.authorized ? " · " : ""}${esc([v.fstype, v.size_gb ? `${v.size_gb}GB` : "", v.kind].filter(Boolean).join(" · "))}</span>`
              : "";
            return `<span class="mono vol-path">${esc(path)}</span>${detail}`;
          })()
        }</dd>
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
        1000 分 = ${esc(base.machine?.cpu_model || "基准机")}（${esc(base.machine?.threads || "?")} 线程${base.machine?.boost === "off" ? "，睿频关闭" : ""}）
        ${base.measured_at ? ` · ${new Date(base.measured_at).toLocaleDateString("zh-CN")}` : ""}
      </div>
    </div>`;

  const whyCard = `<div class="card tight">
      <div class="card-head"><h2>测量范围</h2></div>
      <div class="notice">
        测：CPU 单核/多核、AES-256-GCM、zlib、内存带宽与延迟、磁盘顺序与 4K 随机（O_DIRECT）。<br/>
        不测：显卡编解码、网络吞吐、功耗与噪音。<br/>
        磁盘测试会在测试卷写入临时文件，结束后删除。
      </div>
    </div>`;

  const lastDeep = boot?.lastDeep;
  const deepPresets = [180, 300, 600, 1200];
  const deepCard = `<div class="card deep-card">
      <div class="card-head">
        <h2>持续负载（深度档）</h2>
        <span class="sub">纯本地运行，结果只存本机、不上榜</span>
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
      <div class="field">
        <div class="field-label">烤机时长</div>
        <div class="seg">
          ${deepPresets
            .map(
              (sec) =>
                `<button class="btn sm ${state.deep.durationSec === sec ? "primary" : "ghost"}" data-action="deep-duration" data-sec="${sec}">${sec / 60} 分钟</button>`,
            )
            .join("")}
        </div>
        <p class="field-hint">烤完立刻复测一次多核，看满载后还剩多少性能${state.deep.durationSec >= 300 ? "。时间越长越能看出散热瓶颈，5 分钟是常用档" : ""}。</p>
      </div>

      <div class="field">
        <div class="field-label">附加压力</div>
        <label class="check">
          <input type="checkbox" id="deep-disk" ${state.deep.loadDisk ? "checked" : ""} />
          叠加磁盘写压力
        </label>
        <p class="field-hint">更接近 RAID 重建时的机箱温度，代价是会消耗 SSD 写入寿命，按需开启。</p>
      </div>

      <div class="deep-actions">
        <button class="btn ${deepRunning ? "" : "primary"}" data-action="start-deep" ${deepRunning ? "disabled" : ""} title="满载运行，看长时间跑下来还剩多少性能">大试牛刀</button>
        <span class="field-hint">将满载 ${state.deep.durationSec / 60} 分钟，建议在没人使用 NAS 的时候跑</span>
      </div>

      <details class="deep-method">
        <summary>怎么判定</summary>
        <ul>
          <li>稳定性 = 满载期间<b>最差一轮吞吐 ÷ 最好一轮吞吐</b>，逐轮取样，不靠单点。</li>
          <li>分四档：≥97% 合格、94–97% 轻微衰减、88–94% 明显降频、&lt;88% 散热吃紧。</li>
          <li>温度与频率作为旁证一并记录：温度高但没降频，说明散热还 hold 得住。</li>
        </ul>
      </details>
    </div>`;

  return `<div class="grid-2">
    <div class="stack">${heroCard}
      ${deepCard}
    </div>
    <div class="stack">${hwCard}${whyCard}</div>
  </div>`;
}

/** 深度档报告：结论 + 逐轮稳定性 + 温频曲线 */
function deepResultView(r) {
  const s = r.stability || {};
  const v = s.verdict || {};
  const steady = s.stability || null;
  const boost = s.boost || s.perf || null;
  const temp = s.temp || null;
  const freq = s.freq || null;
  const rounds = (r.rounds || s.rounds || []).map((x) => (typeof x === "number" ? { mops: x } : x));
  const roundValues = rounds.map((x) => x.mops).filter((n) => Number.isFinite(n));
  const tempSeries = (r.series || []).map((p) => ({ t: p.t, value: p.cpuC }));
  const freqSeries = (r.series || []).map((p) => ({ t: p.t, value: p.freqMhz }));

  const cell = (label, value, hint = "") =>
    `<div class="stat">
       <div class="stat-label">${esc(label)}</div>
       <div class="stat-value">${value}</div>
       ${hint ? `<div class="stat-hint">${esc(hint)}</div>` : ""}
     </div>`;

  const steadyCell = steady
    ? cell(
        "满载稳定性",
        `<span style="color:${steady.pct >= 97 ? "var(--good)" : steady.pct >= 92 ? "var(--warn)" : "var(--bad)"}">${num(steady.pct, 1)}%</span>`,
        `最差 ${num(steady.worstMops)} / 最好 ${num(steady.bestMops)} MOps/s · ${steady.rounds} 轮`,
      )
    : cell("满载稳定性", `<span class="faint">样本不足</span>`, "逐轮不足 3 轮，退回冷/热口径");

  const boostCell = boost
    ? cell("加速回落", `${num(boost.coldMops)} → ${num(boost.hotMops)}`, `冷态到热态 ${num(boost.keepPct, 1)}%（仅供参考）`)
    : cell("加速回落", `<span class="faint">未测</span>`);

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
        ${s.probeSec ? `<span class="pill">每 ${s.probeSec}s 一轮</span>` : ""}
      </div>
      <div class="score-sub" style="margin-top:8px">${esc(v.detail || "")}</div>
      ${
        Array.isArray(s.tiers) && s.tiers.length
          ? `<div class="tier-row" style="margin-top:12px">
              <span class="faint" style="font-size:12px">判定档位：</span>
              ${s.tiers
                .map(
                  (t) =>
                    `<span class="pill ${t.level === v.level ? "on" : ""}" title="${esc(t.hint || "")}">≥${t.min}% ${esc(t.label)}</span>`,
                )
                .join("")}
            </div>`
          : ""
      }
      <div class="row" style="margin-top:14px;gap:8px;flex-wrap:wrap">
        <a class="btn" href="api/results/${esc(r.id)}/report.md" target="_blank" rel="noreferrer">Markdown 报告</a>
        <a class="btn ghost" href="api/results/${esc(r.id)}/export.json">导出 JSON</a>

      </div>
    </div>

    <div class="grid-3">
      <div class="card tight">${steadyCell}${boostCell}</div>
      <div class="card tight">
        ${temp
          ? cell("温度", `${num(temp.startC, 1)} → ${num(temp.endC, 1)} <span class="faint" style="font-size:12px">°C</span>`, `最高 ${num(temp.maxC, 1)}°C · 升温 ${num(temp.riseC, 1)}°C`)
          : cell("温度", `<span class="faint">无传感器</span>`)}
        ${temp && temp.plateauSec !== null ? cell("到达 90% 稳态", `${temp.plateauSec}s`) : ""}
      </div>
      <div class="card tight">
        ${freq
          ? cell("频率", `${num(freq.peakMhz)} → ${num(freq.steadyMhz)} <span class="faint" style="font-size:12px">MHz</span>`, freq.nominalMhz ? `标称最高 ${num(freq.nominalMhz)} MHz` : "")
          : cell("频率", `<span class="faint">无频率信息</span>`)}
        ${freq && freq.dropPct !== null ? cell("频率下降", `${num(freq.dropPct, 1)}%`) : ""}
      </div>
    </div>

    ${
      roundValues.length
        ? `<div class="card">
             <div class="card-head"><h2>逐轮吞吐</h2><span class="sub">稳定性 = 最差轮 ÷ 最好轮；亮色为最好，红色为最差</span></div>
             ${roundBars(roundValues, { unit: "MOps/s", best: steady?.bestMops, worst: steady?.worstMops })}
             <div class="faint" style="font-size:11.5px;margin-top:6px">共 ${roundValues.length} 轮，每 ${s.probeSec || "?"} 秒一轮；首轮与末尾残段不计入稳定性</div>
           </div>`
        : ""
    }

    <div class="card">
      <div class="card-head"><h2>温度曲线</h2><span class="sub">逐秒采样，降采样保留峰值</span></div>
      ${lineChart(tempSeries, { color: "#ffb545", unit: "°C", height: 160, label: "温度曲线", id: "res-temp", threshold: 90, thresholdLabel: "90°C 警示" })}
      <div class="divider"></div>
      <div class="card-head"><h2>频率曲线</h2><span class="sub">降频是否被功耗墙压住，一眼能看出来</span></div>
      ${lineChart(freqSeries, { color: "#57c1ff", unit: "MHz", height: 140, label: "频率曲线", id: "res-freq" })}
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
/** 报告第一屏的结论：先回答"我这台怎么样"，再谈十行指标 */
function verdictCard() {
  const v = state.verdict;
  if (state.verdictLoading && !v) {
    return `<div class="verdict"><div class="verdict-line faint">正在生成结论…</div></div>`;
  }
  if (!v) return "";
  const lines = (v.lines || []).map((l) => `<div class="verdict-line">${esc(l)}</div>`).join("");
  const badge = v.sameModel
    ? `<span class="pill ${v.sameModel.others ? "good" : ""}">同型号 ${v.sameModel.total} 台</span>`
    : "";
  const warn = v.board?.ok === false
    ? `<div class="faint" style="font-size:11.5px;margin-top:6px">公共榜暂时连不上，以上结论只基于本机成绩。</div>`
    : "";
  return `<div class="verdict">
    <div class="verdict-head">体检结论 ${badge}</div>
    ${lines}
    ${warn}
  </div>`;
}

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
      <div class="card-head">
        <h2>性能报告</h2>
        <span class="sub">${new Date(r.ts).toLocaleString("zh-CN", { hour12: false })}</span>
        <span class="spacer"></span>
        ${gradeBadge(r.grade?.grade || "D")}
        ${r.submitted ? `<span class="pill good">已提交</span>` : ""}
        ${(r.scores.capped || []).length ? `<span class="pill warn" title="${esc(cappedTitle(r))}">${(r.scores.capped || []).length} 项超物理上限</span>` : ""}
        ${r.scores.partial && !(r.scores.capped || []).length ? `<span class="pill warn">部分项缺失</span>` : ""}
      </div>
      <div class="score-row">
        <div class="score-num is-score">${num(s.composite)}<small>综合分</small></div>
        <div class="score-meta">
          <span class="score-sub">CPU ${num(s.dims?.cpu?.score)} · 内存 ${num(s.dims?.memory?.score)} · 存储 ${num(s.dims?.storage?.score)}</span>
          <span class="faint" style="font-size:11.5px">套件 v${esc(r.suite)} · 基准 1,000 = ${esc(state.boot?.baseline?.machine?.cpu_model || "参考机")}</span>
        </div>
        <span class="spacer"></span>
        <div class="row" style="flex-wrap:wrap">
          <button class="btn primary" data-action="submit-result" data-id="${esc(r.id)}">提交到天梯</button>
          <a class="btn ghost" href="api/results/${esc(r.id)}/report.md" target="_blank" rel="noreferrer">Markdown</a>
          <a class="btn ghost" href="api/results/${esc(r.id)}/export.json">JSON</a>
        </div>
      </div>
      <div class="deep-cta">
        <div class="deep-cta-title">还想知道这台机器扛不扛得住？</div>
        <div class="deep-cta-text">快速档只能说明"现在有多快"。深度档会满载烤机 ${state.deep.durationSec / 60} 分钟，看温度和频率会不会掉下来 —— NAS 玩家真正要担心的是这个。</div>
        <button class="btn primary" data-action="start-deep">跑 ${state.deep.durationSec / 60} 分钟深度体检</button>
        <button class="btn ghost sm" data-action="go-home-deep">先改时长</button>
        <button class="btn ghost sm" data-action="feedback">这份成绩有问题？</button>
      </div>
      <div class="divider"></div>
      ${verdictCard()}
      ${dims.map(([k, d]) => dimBlock(k, d, s.dims?.[k])).join("")}
    </div>

    <div class="grid-2">
      <div class="card">
        <details class="metrics-details" ${state.showMetrics ? "open" : ""} id="metrics-details">
          <summary class="card-head" style="cursor:pointer;list-style:none">
            <h2>原始指标</h2><span class="sub">归一化分 = 实测 / 基准 × 1000</span>
          </summary>
        <table class="table">
          <thead><tr><th>指标</th><th class="num">实测</th><th class="num">归一化</th><th>测法</th></tr></thead>
          <tbody>
            ${metrics
              .filter(([k]) => r.metrics[k] !== undefined)
              .map(([k, def]) => {
                const raw = r.metrics[k];
                const shown =
                  raw >= 1000 ? num(raw) : raw >= 10 ? num(raw, 1) : num(raw, 2);
                return `<tr><td>${esc(def.label)}</td><td class="num">${shown} <span class="faint">${esc(def.unit)}</span></td><td class="num">${s.subs[k] === undefined ? "—" : num(s.subs[k], 1)}</td><td class="faint" style="font-size:11.5px">${esc(howMeasured(r, k))}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
        ${
          r.detail?.scaling
            ? `<div class="hint-box" style="margin-top:14px">多核扩展效率 <b class="mono">${num(r.detail.scaling, 1)}%</b>（100% = 完美线性；开了超线程的机器通常 40–60%，因为两个逻辑核共享执行单元。这个数字看的是"多核有没有被功耗墙或内存带宽压住"）</div>`
            : ""
        }
        </details>
      </div>

      <div class="card">
        <div class="card-head"><h2>硬件档案</h2></div>
        <dl class="kv">
          <dt>CPU</dt><dd>${esc(r.hardware.cpu_model)}</dd>
          <dt>核心</dt><dd>${r.hardware.cores} 核 / ${r.hardware.threads} 线程</dd>
          <dt>测试频率</dt><dd>${clockCell(r)}</dd>
          <dt>内存</dt><dd>${r.hardware.mem_gb} GB${r.hardware.mem_gib ? ` <span class="faint">（可见 ${r.hardware.mem_gib} GiB）</span>` : ""}</dd>
          <dt>整机</dt><dd>${esc(r.hardware.board || "—")}</dd>
          <dt>显卡</dt><dd>${esc(r.hardware.gpu || "—")}</dd>
          <dt>系统</dt><dd>fnOS ${esc(r.hardware.os_version)} · ${esc(r.hardware.kernel)}</dd>
          <dt>测试卷</dt><dd class="mono">${esc(r.hardware.volume)}</dd>
          <dt>运行环境</dt><dd>${envCell(r)}</dd>
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
  const myCpu = state.boot?.hardware?.hardware?.cpu_model || "";
  // 默认"全部架构"：榜上人还不多，先让人看到全貌；
  // 想认真比就点同型号或切架构（一排按钮，不用下拉）。
  const dims = [
    ["overall", "综合"],
    ["cpu", "CPU"],
    ["memory", "内存"],
    ["storage", "存储"],
  ];

  // 三行分开：维度 / 赛道 / 架构。原来挤在一行里，8 组按钮平铺，
  // 用户要在一排里找"我该点哪个"，分类反而变模糊了。
  const filters = `<div class="board-filters">
      <div class="filter-row">
        <span class="filter-label">维度</span>
        <span class="seg">
          ${dims
            .map(
              ([k, label]) =>
                `<button class="btn sm ${state.board.dim === k ? "primary" : "ghost"}" data-action="board-dim" data-dim="${k}">${label}</button>`,
            )
            .join("")}
        </span>
        <button class="btn sm ${state.board.cpuOnly ? "primary" : "ghost"}" data-action="board-cpu" title="只和同一颗 CPU 的机器比">${state.board.cpuOnly ? "✓ 同型号" : "同型号"}</button>
      </div>
      <div class="filter-row">
        <span class="filter-label">赛道</span>
        <span class="seg">
          ${[
            ["physical", "物理机"],
            ["vm", "虚拟机"],
          ]
            .map(
              ([v, label]) =>
                `<button class="btn sm ${state.board.track === v ? "primary" : "ghost"}" data-action="board-track" data-track="${v}">${label}</button>`,
            )
            .join("")}
        </span>
        <span class="filter-note">虚拟机的硬件来自宿主机，与物理机分开排名</span>
      </div>
      <div class="filter-row">
        <span class="filter-label">架构</span>
        <span class="seg">
          ${[
            ["", "全部"],
            ["x64", "x86_64"],
            ["arm64", "ARM64"],
          ]
            .map(
              ([v, label]) =>
                `<button class="btn sm ${state.board.arch === v ? "primary" : "ghost"}" data-action="board-arch" data-arch="${v}">${label}</button>`,
            )
            .join("")}
        </span>
        <span class="filter-note">ARM 与 x86 只在各自架构内可比</span>
      </div>
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
      const rawKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
      if (!rawKeys.length) return "";
      const lo = Math.min(...rawKeys);
      const hi = Math.max(...rawKeys);
      // 档宽自适应：100 分一档在分数跨度大时会切出几十个空档，柱子细得看不清。
      // 目标 10–14 档，档宽从 100 起逐级放大。
      const span = hi - lo + 100;
      const bw = [100, 200, 250, 500, 1000, 2000].find((w) => span / w <= 14) || 2000;
      const start = Math.floor(lo / bw) * bw;
      const slots = [];
      for (let k = start; k <= hi; k += bw) {
        let n = 0;
        for (let j = k; j < k + bw; j += 100) n += buckets[j] || 0;
        slots.push({ from: k, to: k + bw - 1, n });
      }
      const max = Math.max(1, ...slots.map((x) => x.n));
      const mySlot = me && Number.isFinite(me.value) ? slots.findIndex((x) => me.value >= x.from && me.value <= x.to) : -1;
      const total = data.total || 0;
      const kfmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v));
      return `<div class="dist">
        <div class="dist-head">
          <span>分数分布</span>
          <span class="faint">每 ${bw} 分一档 · 柱高 = 该档机器数 · 共 ${num(total)} 台</span>
        </div>
        <div class="dist-plot">
          ${slots
            .map((slot, i) => {
              const h = slot.n === 0 ? 0 : Math.max(5, (slot.n / max) * 100);
              const isMine = i === mySlot;
              return `<div class="dist-slot${isMine ? " is-mine" : ""}${slot.n === 0 ? " is-empty" : ""}"
                          title="${slot.from}–${slot.to} 分：${slot.n} 台${isMine ? "（我这里）" : ""}">
                ${slot.n > 0 ? `<span class="dist-num">${slot.n}</span>` : ""}
                <i style="height:${h}%"></i>
              </div>`;
            })
            .join("")}
        </div>
        <div class="dist-axis">
          <span>${kfmt(slots[0].from)}</span>
          ${mySlot >= 0 ? `<span class="dist-me" style="left:${((mySlot + 0.5) / slots.length) * 100}%">我</span>` : ""}
          <span>${kfmt(slots[slots.length - 1].to)}</span>
        </div>
      </div>`;
    })();
    const stats = data.stats || null;
    const staleNote = data.unavailable
      ? `<div class="hint-box" style="margin-bottom:12px;border-left-color:var(--warn);color:var(--warn)">${esc(data.warning || "排行榜暂时连不上")}</div>`
      : data.stale
      ? `<div class="hint-box" style="margin-bottom:12px;border-left-color:var(--warn);color:var(--warn)">${esc(data.warning || "数据可能不是最新")}</div>`
      : "";
    const statsLine = stats
      ? stats.gated
        ? `<div class="hint-box" style="margin-bottom:12px">
             样本不足：当前 <b class="mono">${num(stats.n)}</b> 台，凑够 <b class="mono">${num(stats.n + stats.needed)}</b> 台才显示百分位（再差 ${num(stats.needed)} 台）。
             统计口径参考 Speedtest Global Index：样本不够就不给名次百分比。
             ${stats.median ? `<br/>当前中位数 <b class="mono">${num(stats.median)}</b>。` : ""}
           </div>`
        : stats.median
          ? `<div class="faint" style="font-size:12px;margin-bottom:10px">
               共 <b class="mono">${num(stats.n)}</b> 台 · 中位数 <b class="mono">${num(stats.median)}</b>${
                 stats.ci ? ` · 95% 置信区间 ${num(stats.ci[0])}–${num(stats.ci[1])}` : ""
               }
             </div>`
          : ""
      : "";
    body += `
      ${staleNote}
      ${statsLine}
      ${
        me
          ? `<div class="hint-box" style="margin-bottom:14px">
              你这台在 <b class="mono">${num(data.total)}</b> 台机器里排第 <b class="mono">${num(me.rank)}</b>${
                me.percentile !== null && me.percentile !== undefined
                  ? `，超过 <b class="mono">${num(me.percentile, 1)}%</b> 的机器`
                  : `（样本不足 ${num(stats?.n ?? data.total)}/${num((stats?.n ?? 0) + (stats?.needed ?? 0))}，暂不给百分位）`
              }。
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
              (e) => {
                // "这一行是不是我"必须按机器身份判断，不能按名次：重名时名次也对不上
                const mineRow = e.isMine !== undefined ? e.isMine : me && e.rank === me.rank;
                const label = e.alias || (data.mode === "remote" ? e.hardware?.cpu_model || "匿名机器" : "本机 · " + (e.hardware?.cpu_model || ""));
                return `<tr class="${mineRow ? "is-me" : ""}">
                <td class="rank-cell ${e.rank <= 3 ? "top" : ""}">${e.rank}</td>
                <td>
                  <div class="truncate">${esc(label)}${mineRow ? ` <span class="pill good" style="font-size:10px">我的</span>` : ""}</div>
                  <div class="faint" style="font-size:11.5px">${esc(e.hardware?.cpu_model || "")}${e.hardware?.mem_gb ? ` · ${e.hardware.mem_gb}GB` : ""}${e.arch ? ` · ${esc(e.arch)}` : ""}${e.envType && e.envType !== "physical" ? ` · <span title="跑在虚拟化环境里，与物理机分开排名">${esc(e.vmTech || (e.envType === "container" ? "容器" : "虚拟机"))}</span>` : ""}${e.dup && !mineRow ? ` · <span title="花名相同，但这是另一台机器">同名不同机</span>` : ""}</div>
                </td>
                <td class="num">${num(e.value)}</td>
                <td class="num faint">${num(e.composite)}</td>
              </tr>`;
              },
            )
            .join("")}
        </tbody>
      </table>`;
  }

  return `<div class="stack">
    <div class="card">
      <div class="card-head"><h2>天梯</h2>
        <span class="sub">${
          data?.mode === "remote"
            ? state.boot?.leaderboard?.official
              ? "官方榜"
              : "自建榜单"
            : "本机成绩"
        }</span>
        <span class="spacer"></span>
        ${data?.total ? `<span class="pill">${num(data.total)} 台机器</span>` : ""}
        ${state.board.cpuOnly ? `<span class="pill good">同型号</span>` : ""}
        ${/* 刷新挨着"机器数"放：用户想刷新的动机就是"数字变了没" */""}
        <button class="btn sm ghost" data-action="board-refresh">刷新</button>
      </div>
      ${filters}
      <div class="divider"></div>
      ${body}
    </div>
    <div class="hint-box">
      ${state.board.cpuOnly ? `当前只看 <b>${esc(myCpu)}</b> 的样本；点上面「同型号」可切回全部机器。<br/>` : ""}
      榜单只接受本套件版本的原始指标，分数由服务端重算 —— 客户端改分数没有用。<br/>
      同一台机器（按硬件指纹认）只保留<b>最好的一次</b>：跑多次、交多次，榜上不会出现两条；重跑出更低的分不会顶掉原成绩。<br/>
      花名只用来显示，可以重名 —— 区分机器靠指纹，所以和同名的人不会互相覆盖。<br/>
      <b>分数只在同一架构内直接可比</b>：ARM 与 x86 的指令集、内存模型、磁盘栈都不同，
      整体榜放在一起只是为了热闹，真正有意义的是「同型号」和按架构筛选。<br/>
      <b>物理机与虚拟机分开排名</b>：虚拟机的 CPU/内存/磁盘都是宿主的，磁盘还常被页缓存放大，
      混在一起比没有意义。判定依据来自内核（DMI 特征 + hypervisor 标志位），报告里会写出来。
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
  // 内置公共榜是默认值，不把它当"用户填的东西"展示出来
  const officialLb = state.boot?.leaderboard?.official === true;
  return `<div class="stack" style="max-width:720px">
    <div class="card">
      <div class="card-head"><h2>天梯</h2><span class="sub">默认就和所有装了牛刀的机器排在一起</span></div>
      <div class="field">
        <div class="field-label">榜单显示名</div>
        <div class="alias-fixed">${esc(s.alias || state.boot?.hostname || "（读取中）")}</div>
        <p class="field-hint">固定使用本机的设备名称（安装时自动读取），不提供自定义。</p>
      </div>

      <div class="field">
        <label class="check">
          <input type="checkbox" id="f-autoSubmit" ${s.autoSubmit !== false ? "checked" : ""} />
          测完自动提交
        </label>
        <p class="field-hint">关掉的话，成绩只留在本机，需要手动点提交才上榜。</p>
      </div>

      <div class="row" style="gap:8px;margin-top:14px">
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
          ${
            // 当前值不在下拉选项里时（用户自己填了子目录），也要作为一项列出来，
            // 否则浏览器的下拉看起来"没有这个值"，像是输入无效。
            (() => {
              const cur = String(s.targetDir || "");
              const vols = (state.boot?.hardware?.volumes || []).filter((v) => v?.mount);
              const known = new Set(vols.map((v) => v.mount));
              // ① 当前值（用户可能在列表里找不到它，得先列出来）
              const mine = cur && !known.has(cur) ? `<option value="${esc(cur)}" label="当前使用中"></option>` : "";
              // ② 以前填成功过的路径：授权子目录在卷根不可读时枚举不出来，只能靠记忆
              const recents = (s.recentTargetDirs || [])
                .filter((d) => d && d !== cur && !known.has(d))
                .map((d) => `<option value="${esc(d)}" label="用过的路径"></option>`)
                .join("");
              // ③ 探测到的卷/可写目录：可写的排前面
              const sorted = [...vols].sort((a, b) => Number(Boolean(b.authorized)) - Number(Boolean(a.authorized)));
              return (
                mine +
                recents +
                sorted.map((v) => `<option value="${esc(v.mount)}" label="${esc(volLabel(v))}"></option>`).join("")
              );
            })()
          }
        </datalist>
        <span class="hint">
          可以直接输入任意<b>有写权限的路径</b>（如 <span class="mono">/vol4/1000/niudao benchmark</span>）。
          在飞牛「应用设置 → 访问权限」里加好目录后<b>立即生效，不用重启应用</b>；
          但卷根对应用不可读，我列不出你授权的子目录，所以填一次成功之后会记住它。
        </span>
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
        <dt>基准机</dt><dd>${esc(state.boot?.baseline?.machine?.cpu_model || "—")}${
          state.boot?.baseline?.machine?.boost === "off"
            ? ` <span class="faint">（睿频关闭，${esc(state.boot?.baseline?.machine?.freq_mhz || 2000)} MHz）</span>`
            : ""
        }</dd>
        <dt>数据</dt><dd class="faint">本机成绩存在应用数据目录（results.jsonl），删除应用前先导出。</dd>
      </dl>
      <div class="divider"></div>
      <div class="mp-block">
        ${mpQrCode(112)}
        <div class="mp-info">
          <div class="mp-title">微信搜一搜</div>
          <div class="mp-name">${esc(MP_NAME)}</div>
          <div class="mp-desc">版本更新、新机型实测数据、装机避坑，都发在这里。手机扫码也能直接关注。</div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <button class="btn" data-action="open-feedback">反馈问题 / 发送日志</button>
        <span class="faint" style="font-size:12px">发现算错、卡住、看不懂 —— 点这里，带上环境与日志，我才能改得动。</span>
      </div>
    </div>
  </div>`;
}

/* ---------------- 路由（hash，可分享可刷新） ---------------- */
const ROUTES = new Set(["home", "board", "history", "settings", "result"]);

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [view, id] = raw.split("/");
  return { view: ROUTES.has(view) ? view : "home", id: id ? decodeURIComponent(id) : null };
}

function navigate(hash) {
  if (location.hash === hash) return applyRoute();
  location.hash = hash;
}

async function applyRoute() {
  const { view, id } = currentRoute();
  if (view === "result") {
    if (!id) return navigate("#/home");
    if (state.result?.id !== id) {
      try {
        state.result = await api(`/api/results/${encodeURIComponent(id)}`);
        loadVerdict(id); // 异步，别挡住报告打开
      } catch (e) {
        toast(e.message, "err");
        return navigate("#/home");
      }
    }
    state.resultId = id;
    state.view = "result";
    render();
    return;
  }
  state.view = view;
  if (view === "board") {
    render();
    loadBoard();
    return;
  }
  await refreshBoot();
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
  navigate(`#/result/${encodeURIComponent(id)}`);
}

async function startRun() {
  try {
    state.fast.liveSeries = [];
    await api("/api/run", { method: "POST", body: JSON.stringify({}) });
    state.view = "home";
    toast("小试牛刀，约 40 秒出结果");
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
    toast(`大试牛刀，满载 ${Math.round(state.deep.durationSec / 60)} 分钟，别走开`);
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
      // 深度档：记录服务端进度的"锚点时间"，本地秒表从这里往前推
      if (run?.progress && typeof run.progress.burnedSec === "number") {
        const prev = state.deep.burnSeen;
        if (prev !== run.progress.burnedSec) {
          state.deep.clockAt = Date.now();
          state.deep.burnSeen = run.progress.burnedSec;
        }
      }
      // 深度档：把实时采样攒成曲线
      if (run.kind === "deep" && run.status === "running" && run.live && typeof run.live.cpuC === "number") {
        const last = state.deep.liveSeries.at(-1);
        if (!last || run.live.t > last.t) state.deep.liveSeries.push({ t: run.live.t, cpuC: run.live.cpuC });
      }
      if (run.kind !== "deep" && run.status === "running" && run.live?.temp && typeof run.live.temp.cpuC === "number") {
        const sample = run.live.temp;
        const series = state.fast.liveSeries;
        if (!series.length || sample.t > series.at(-1).t) series.push({ t: sample.t, cpuC: sample.cpuC });
      }
      state.run = run;
      render();
      if (run.status !== "running") {
        state.deep.clockAt = 0;
        state.deep.burnSeen = null;
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

/** 结果页的"体检结论"：异步拿，不阻塞报告首屏（公共榜慢也只慢这一块） */
/**
 * "页面现场"：出问题时最该被记下来的几件事。
 * 放进反馈包，省掉来回问"你当时在哪个页面、点了什么"。
 */
function feedbackContext() {
  const run = state.run || {};
  const errs = (run.events || []).filter((e) => e.status === "error").map((e) => `${e.stage}: ${e.message || ""}`);
  const parts = [
    `页面: ${location.hash || "#/home"}`,
    `时间: ${new Date().toISOString()}`,
    state.result ? `正在看的成绩: ${state.result.id}（综合 ${state.result.scores?.composite ?? "—"}）` : "",
    run.status ? `最近一次运行: ${run.kind || "fast"} / ${run.status}${run.error ? ` / 错误: ${run.error}` : ""}` : "",
    errs.length ? `失败阶段: ${errs.join("；")}` : "",
    state.board.data ? `榜单: ${state.board.data.mode}${state.board.data.stale ? "（旧数据）" : ""}${state.board.data.unavailable ? "（连不上）" : ""}` : "",
    `视口: ${window.innerWidth}×${window.innerHeight} · 主题 ${document.documentElement.dataset.theme || "-"}`,
  ];
  return parts.filter(Boolean).join("\n");
}

async function loadVerdict(id) {
  if (!id) return;
  state.verdictLoading = true;
  state.verdict = null;
  try {
    const v = await api(`/api/verdict?id=${encodeURIComponent(id)}`);
    if (state.result?.id === id) {
      state.verdict = v;
      render();
    }
  } catch (e) {
    if (state.result?.id === id) {
      state.verdict = { lines: [], error: e.message };
      render();
    }
  } finally {
    state.verdictLoading = false;
  }
}

async function loadBoard({ force = false } = {}) {
  state.board.loading = true;
  state.board.error = null;
  render();
  try {
    const q = new URLSearchParams({ dim: state.board.dim, limit: "50" });
    if (state.board.arch) q.set("arch", state.board.arch);
    if (state.board.cpuOnly) q.set("cpu", "1"); // 同型号：型号由服务端按本机硬件决定
    q.set("track", state.board.track); // 赛道：物理机 / 虚拟机分开排
    // 服务端有 30 秒新鲜期缓存（省掉一次 CF 握手）：手动刷新要绕过它
    if (force) q.set("refresh", "1");
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
  // 榜单地址与令牌不再由用户填：地址随包写死，令牌走内置公共榜不需要
  // 花名不再可改（固定用设备名），榜单地址随包写死
  const patch = {
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
    // 测试目录保存失败时，服务端会带回当前可用的路径。
    // 把输入框退回那个路径 —— 否则用户会卡在"填了坏的、又改不回去"的状态里。
    const fallback = e?.body?.fallback;
    if (fallback) {
      const input = $("#f-targetDir");
      if (input) input.value = fallback;
      toast(`${e.message}（已退回可用目录：${fallback}）`, "err");
    } else {
      toast(e.message, "err");
    }
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
  if (action === "toggle-metrics") {
    state.showMetrics = !state.showMetrics;
    return;
  }
  if (action === "open-feedback") {
    openFeedback({
      api,
      resultId: state.result?.id || null,
      context: feedbackContext(),
      onToast: toast,
    });
    return;
  }
  if (action === "feedback") {
    // 任何位置的"有个问题？"入口都用这个动作，自动带上当前页面与前端错误
    const ctx = [feedbackContext(), clientErrors.length ? `前端错误:\n${clientErrors.slice(-5).join("\n")}` : ""].filter(Boolean).join("\n");
    openFeedback({ api, resultId: state.result?.id || null, context: ctx, onToast: toast });
    return;
  }
  if (action === "go-home-deep") {
    navigate("#/home");
    setTimeout(() => document.querySelector(".deep-card")?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return;
  }
  if (action === "board-track") {
    state.board.track = el.dataset.track;
    return loadBoard();
  }
  if (action === "board-arch") {
    state.board.arch = el.dataset.arch;
    return loadBoard();
  }
  if (action === "board-cpu") {
    state.board.cpuOnly = !state.board.cpuOnly;
    return loadBoard();
  }
  if (action === "board-refresh") return loadBoard({ force: true });
  if (action === "submit-result") {
    try {
      const out = await api(`/api/results/${id}/submit`, { method: "POST", body: JSON.stringify({}) });
      if (out?.kept) toast(out.message || "已保留原成绩", "");
      else toast("已提交到天梯", "ok");
      state.result = await api(`/api/results/${id}`);
      loadVerdict(id); // 提交后名次会变，重新拿结论
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
  if (action === "zoom-qr") {
    // 桌面浏览器里手机扫屏幕，112px 偏小 —— 点一下放大到 260px
    const wrap = document.createElement("div");
    wrap.className = "modal-mask";
    wrap.innerHTML = `<div class="modal modal-qr">
      <h3>微信搜一搜「${esc(MP_NAME)}」</h3>
      <div class="qr-zoom">${mpQrCode(260)}</div>
      <p>扫码直达公众号。版本更新、新机型实测数据、装机避坑都在这里。</p>
      <div class="modal-actions"><button class="btn ghost" data-close="1">关闭</button></div>
    </div>`;
    const close = () => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.closest("[data-close]")) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    return;
  }
  if (action === "delete-result") {
    if (!(await ask("这条成绩会从本机历史里永久移除，无法恢复。", { title: "删除这条成绩？", okText: "删除", danger: true }))) return;
    await api(`/api/results/${id}`, { method: "DELETE" });
    toast("已删除");
    if (state.view === "result") state.view = "history";
    return refreshBoot();
  }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "deep-disk") {
    state.deep.loadDisk = ev.target.checked;
  }
});

document.querySelectorAll("#tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => navigate(`#/${tab.dataset.view}`));
});

bindChartHover(document);

window.addEventListener("hashchange", () => {
  applyRoute().catch((e) => toast(e.message, "err"));
});

(async () => {
  try {
    if (!location.hash) history.replaceState(null, "", "#/home");
    await applyRoute();
    if (state.run?.status === "running") pollRun();
  } catch (e) {
    appEl().innerHTML = `<div class="empty"><h3>加载失败</h3><div>${esc(e.message)}</div></div>`;
  }
})();
