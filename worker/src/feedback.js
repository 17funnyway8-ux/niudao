/**
 * 反馈接收服务（Cloudflare Worker）。
 *
 * 三件事：
 *  1. POST /api/feedback  收反馈（自动脱敏再存，不信任客户端）；
 *  2. GET  /api/feedback  查看列表（需要 ADMIN_TOKEN）；
 *  3. GET  /api/feedback/:id  看单条完整内容（需要 ADMIN_TOKEN）。
 *
 * 隐私是硬要求，所以这里不是"存下来再脱敏"，而是**先脱敏再落库**：
 * 即便有人绕过客户端直接 POST 原始日志，库里也不会出现 IP / 内网路径。
 *
 * 环境变量：
 *   ADMIN_TOKEN  查看反馈用的令牌（和榜单删除用的是同一个 secret 即可）
 */
import { redact } from "./redact.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
  });

const MAX_LEN = 120_000; // 单条反馈上限，防止有人灌日志把 D1 撑爆
const MAX_PER_HOUR = 6; // 同一 IP 每小时最多提交几条

function admin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const auth = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return auth === env.ADMIN_TOKEN;
}

/** 用 D1 记一条限流（不加内存表：Workers 实例随时会换） */
async function overLimit(env, ip) {
  const now = Date.now();
  const window = now - 3600_000;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE ip = ? AND received_at > ?").bind(ip, window).first();
  return (row?.n ?? 0) >= MAX_PER_HOUR;
}

export async function handleFeedback(request, env, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "请求体不是 JSON" }, 400);

    const message = String(body.message || "").trim().slice(0, 4000);
    if (message.length < 4) return json({ error: "描述太短了，至少写几个字，方便定位问题" }, 400);

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    try {
      if (await overLimit(env, ip)) return json({ error: "提交太频繁，请稍后再试" }, 429);
    } catch {
      /* 限流查不到不该挡住真反馈 */
    }

    // 整包（含日志与页面现场）再脱敏一次。用户可能用旧客户端，不能信它。
    const raw = String(body.report || "").slice(0, MAX_LEN);
    const report = redact(raw);
    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO feedback (id, received_at, version, fs_os, arch, cpu_model, mem_gb, contact, message, report, ctx, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        Date.now(),
        String(body.version || "").slice(0, 32),
        String(body.fs_os || "").slice(0, 32),
        String(body.arch || "").slice(0, 16),
        String(body.cpu_model || "").slice(0, 120),
        Number(body.mem_gb) || null,
        redact(String(body.contact || "")).slice(0, 200),
        redact(message),
        report,
        redact(String(body.context || "")).slice(0, 2000),
        ip,
      )
      .run();

    return json({ ok: true, id });
  }

  if (!admin(request, env)) return json({ error: "需要管理员令牌" }, 403);

  const idMatch = url.pathname.match(/^\/api\/feedback\/([\w-]+)$/);
  if (idMatch) {
    const row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?").bind(idMatch[1]).first();
    if (!row) return json({ error: "没有这条反馈" }, 404);
    return json({ ok: true, feedback: row });
  }

  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  const rows = await env.DB.prepare(
    "SELECT id, received_at, version, fs_os, arch, cpu_model, contact, message FROM feedback ORDER BY received_at DESC LIMIT ?",
  )
    .bind(limit)
    .all();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first();
  return json({ ok: true, total: total?.n ?? 0, items: rows.results ?? [] });
}
