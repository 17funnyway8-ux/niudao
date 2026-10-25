/**
 * 前端文件完整性测试。
 *
 * 真实事故：我用一段会在两处同时匹配的字符串做文本替换，删掉了
 * boardView 的后半段和整个 historyView —— 结果点「天梯」显示的是设置页、
 * 点「成绩单」弹 "historyView is not defined"。
 *
 * 而 124 项测试全绿，因为测试只覆盖服务端逻辑，前端是"文本替换完就打包"。
 * 这个文件补上那道闸：**静态检查前端源码的结构完整性**，
 * 不需要跑浏览器就能发现"函数被删了 / 引用了不存在的函数"。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "src/web/app.js"), "utf8");
const INDEX = fs.readFileSync(path.join(ROOT, "src/web/index.html"), "utf8");

/** 收集源码里定义的所有具名函数 */
function definedFunctions(src) {
  const out = new Set();
  for (const m of src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) out.add(m[1]);
  return out;
}

/**
 * 收集源码里所有 `xxxView()` 形式的调用（render 分派用的就是这些）。
 * 排除浏览器原生 API（scrollIntoView 之类）—— 它们也以 View( 结尾但不是我们的函数。
 */
const NATIVE_API = new Set(["scrollIntoView", "requestAnimationFrame"]);
function calledViewFunctions(src) {
  const out = new Set();
  for (const m of src.matchAll(/\b([A-Za-z0-9_$]*View)\s*\(/g)) {
    if (!NATIVE_API.has(m[1])) out.add(m[1]);
  }
  return out;
}

test("每个被调用的 *View() 都必须有定义（防止整段函数被误删）", () => {
  const defined = definedFunctions(APP_JS);
  const called = calledViewFunctions(APP_JS);
  const missing = [...called].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `以下视图函数被调用但没有定义：${missing.join("、")}`);
});

test("路由表里的每个 view 都要有对应的渲染函数", () => {
  const defined = definedFunctions(APP_JS);
  const routeMatch = APP_JS.match(/const ROUTES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(routeMatch, "找不到 ROUTES 定义");
  const routes = routeMatch[1]
    .split(",")
    .map((x) => x.trim().replace(/["']/g, ""))
    .filter(Boolean);
  assert.ok(routes.length >= 4, `路由数量异常：${routes.join(",")}`);
  for (const r of routes) {
    const fn = `${r}View`;
    assert.ok(defined.has(fn), `路由 ${r} 需要 ${fn}()，但没有定义`);
  }
});

test("核心视图一个都不能少（首页/天梯/成绩单/设置/报告）", () => {
  const defined = definedFunctions(APP_JS);
  for (const fn of ["homeView", "boardView", "historyView", "settingsView", "resultView"]) {
    assert.ok(defined.has(fn), `缺少 ${fn}() —— 这会让对应页面直接报 "is not defined"`);
  }
});

test("设置页不再提供花名输入（展示名固定用设备名）", () => {
  assert.ok(!APP_JS.includes('id="f-alias"'), "花名输入框应已移除");
  // 服务端也不接收 alias：前端不该再把 alias 塞进 patch
  const save = APP_JS.slice(APP_JS.indexOf("async function saveSettings"));
  const body = save.slice(0, save.indexOf("\n}"));
  assert.ok(!/alias\s*:/.test(body), "saveSettings 不该再提交 alias");
});

test("静态资源带版本串（升级后强制重新拉取，避免看到旧前端）", () => {
  assert.match(INDEX, /app\.js\?v=__V__/, "app.js 必须带版本占位符");
  assert.match(INDEX, /styles\.css\?v=__V__/, "styles.css 必须带版本占位符");
  assert.match(INDEX, /__BASE__/, "必须有 __BASE__ 占位符供网关前缀注入");
});
