/**
 * 反馈脱敏测试 —— 这是隐私边界，必须守死。
 *
 * 两份实现必须同源：src/server/feedback.js（打包/预览时用）
 * 和 worker/src/redact.js（服务端落库前用）。任何一边规则漂移，
 * 都可能把用户的 IP / 主机名 / 目录泄露到公共数据库里。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, pickLogLines, redact as redactApp } from "../src/server/feedback.js";
import { redact as redactWorker } from "../worker/src/redact.js";

const NASTY = [
  "公网 8.8.8.8",
  "内网 10.0.0.5:8790",
  "本机 127.0.0.1:7788",
  "局域网 192.168.1.10",
  "172 段 172.20.1.5",
  "路径 /vol1/1000/我的资料/私人照片/a.jpg",
  "token=abcdef123456",
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc',
  '{"hostname":"nas-yang"}',
  "hostname: nas-yang",
];

test("两端脱敏结果一致（规则不许漂移）", () => {
  const text = NASTY.join("\n");
  assert.equal(redactApp(text), redactWorker(text), "应用端与 Worker 端的脱敏结果必须一模一样");
});

test("IP / 路径 / 令牌 / 主机名都不会漏出去", () => {
  const out = redactApp(NASTY.join("\n"));
  for (const leak of ["8.8.8.8", "10.0.0.5", "127.0.0.1", "192.168.1.10", "172.20.1.5"]) {
    assert.ok(!out.includes(leak), `漏了 IP：${leak}`);
  }
  assert.ok(!out.includes("我的资料"), "漏了用户目录");
  assert.ok(out.includes("/vol1/1000/"), "卷根应保留，用来判断是哪块盘");
  assert.ok(!out.includes("abcdef123456"), "漏了令牌");
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), "漏了 Bearer");
  assert.ok(!out.includes("nas-yang"), "漏了主机名");
});

test("不误伤版本号与套件号", () => {
  const out = redactApp("版本 1.2.1 套件 1.0.0 内核 6.18.18 端口 7788");
  assert.match(out, /1\.2\.1/);
  assert.match(out, /1\.0\.0/);
  assert.match(out, /6\.18\.18/);
});

test("日志只挑错误/告警与关键事件，逐请求 debug 不要", () => {
  const raw = [
    { t: "1", level: "debug", event: "http", route: "/api/health" },
    { t: "2", level: "info", event: "run_start", kind: "fast" },
    { t: "3", level: "warn", event: "event_loop_blocked", maxMs: 3900 },
    { t: "4", level: "error", event: "api_error", message: "boom" },
    { t: "5", level: "info", event: "some_noise" },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  const picked = pickLogLines(raw);
  const events = picked.map((r) => r.event);
  assert.deepEqual(events, ["run_start", "event_loop_blocked", "api_error"], "只保留关键事件，且保持时间顺序");
});

test("反馈包结构完整：环境、现场、日志，且整体已脱敏", () => {
  const report = buildReport({
    message: "点开始体检后页面白屏",
    contact: "wx: fun",
    context: "#/home · 点击 start-run",
    env: { version: "1.2.1", fnOS: "1.2.0800", hostname: "nas-yang", 榜单: "https://fnbench.1133891.xyz" },
    logRaw: JSON.stringify({ t: "t1", level: "error", event: "api_error", message: "connect ECONNREFUSED 192.168.1.10:8790" }),
  });
  assert.match(report, /=== 牛刀反馈包 ===/);
  assert.match(report, /点开始体检后页面白屏/);
  assert.match(report, /version: 1.2\.1/);
  assert.match(report, /#\/home/);
  assert.match(report, /api_error/);
  assert.ok(!report.includes("nas-yang"), "环境里的主机名必须被抹掉");
  assert.ok(!report.includes("192.168.1.10"), "日志里的内网 IP 必须被抹掉");
});
