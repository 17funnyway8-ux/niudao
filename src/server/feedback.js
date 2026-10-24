/**
 * 反馈包：把"排查问题需要的证据"打包成一个可读的文本包。
 *
 * 设计原则（比"顺手把日志全发出去"重要得多）：
 *  1. **先在本地脱敏，再决定发不发**：IP、主机名、内网路径、令牌全抹掉；
 *  2. **用户能看见要发什么**：返回的是人可读文本，界面上原样展示，用户亲手点提交；
 *  3. **默认不带成绩明细**：只带环境 + 错误 + 最近日志，成绩要用户另外勾选；
 *  4. 服务端再脱敏一次（不信任客户端），因为用户可能有旧版本。
 */

/** 脱敏：把可能泄露隐私/敏感信息的内容替换掉。私网优先，再做公网兜底。 */
export function redact(text) {
  let out = String(text ?? "");

  // 1) 私网 / 本机 IP（含端口）。10.x 与 127.x 的第三段可以是 0，别用固定两段的宽松写法。
  out = out.replace(
    /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{2,5})?(?![\d.])/g,
    "[内网IP]",
  );

  // 2) IPv6
  out = out.replace(/\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/gi, "[IPv6]");

  // 3) Bearer 先处理：否则 "Authorization: Bearer xxx" 会被下面的规则拆成两段，token 漏出去
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[已隐藏]");
  // 4) 令牌 / 密钥
  out = out.replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, "$1[已隐藏]");

  // 5) 用户目录：保留卷根（能定位是哪块盘），抹掉后面的目录结构
  out = out.replace(/(\/(?:vol\d+|volume\d+|mnt|media|home)\/[^/\s"']+)(\/[^\s"',}]*)?/g, "$1/[已隐藏]");

  // 6) 主机名（JSON 与非 JSON 两种形态）
  out = out.replace(/("hostname"\s*:\s*")[^"]*(")/g, "$1[已隐藏]$2");
  out = out.replace(/(^|\n)\s*hostname\s*[:=]\s*\S+/gi, "$1hostname: [已隐藏]");
  out = out.replace(/\bhostname\s*[:=]\s*\S+/gi, "hostname: [已隐藏]");

  // 7) 公网 IPv4 兜底：私网已被替换，剩下四段数字且不像版本号（三段）的都抹掉
  out = out.replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, "[公网IP]");

  return out;
}

/** 从 jsonl 日志里挑出"值得给人看的行"：错误/告警 + 关键事件，丢弃逐请求的 debug */
export function pickLogLines(raw, { maxLines = 120 } = {}) {
  const KEEP = new Set([
    "run_start",
    "run_done",
    "deep_start",
    "deep_done",
    "error",
    "api_error",
    "uncaught_exception",
    "unhandled_rejection",
    "event_loop_blocked",
    "edge_selected",
    "edge_select_failed",
    "board_cache_save_failed",
    "submit_failed",
    "shutdown",
  ]);
  const lines = String(raw || "").split("\n");
  const kept = [];
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const level = rec.level || "";
    if (KEEP.has(rec.event) || level === "error" || level === "warn") kept.push(rec);
  }
  return kept.reverse();
}

/**
 * 组装反馈包。
 * @param {object} input
 * @param {string} input.message        用户描述
 * @param {string} input.contact        可选联系方式
 * @param {string} [input.context]      前端记录的现场（哪一页、跑了什么、报了什么错）
 * @param {object} [input.env]          环境摘要（版本、fnOS、CPU、榜单状态）
 * @param {string} [input.logRaw]       原始 app.jsonl 内容
 * @param {object} [input.result]       可选：附带最近一次成绩
 */
export function buildReport({ message, contact = "", context = "", env = {}, logRaw = "", result = null } = {}) {
  const now = new Date().toISOString();
  const envLines = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);

  const logLines = pickLogLines(logRaw).map((r) => {
    const { t, level, event, ...rest } = r;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : "";
    return `${t} [${level}] ${event}${extra}`;
  });

  const parts = [
    "=== 牛刀反馈包 ===",
    `生成时间: ${now}`,
    "",
    "--- 用户描述 ---",
    String(message || "(未填写)").trim(),
    contact ? `联系方式: ${contact}` : "",
    "",
    "--- 环境 ---",
    ...envLines,
    "",
    "--- 页面现场 ---",
    String(context || "(无)").trim() || "(无)",
    "",
  ];

  if (result) {
    const m = result.metrics || {};
    parts.push(
      "--- 附带的成绩 ---",
      `id: ${result.id}`,
      `时间: ${new Date(result.ts || Date.now()).toISOString()}`,
      `套件: ${result.suite} / 客户端: ${result.client}`,
      `综合分: ${result.scores?.composite ?? "—"}`,
      `指标: ${JSON.stringify(m)}`,
      `耗时: ${JSON.stringify(result.durations || {})}`,
      `说明: ${JSON.stringify(result.caveats || [])}`,
      "",
    );
  }

  parts.push("--- 最近日志（错误/告警 + 关键事件）---", ...(logLines.length ? logLines : ["(没有可用的日志)"]), "");

  return redact(parts.join("\n"));
}
