#!/usr/bin/env node
/**
 * 把「单一数据源」编译成 Worker 可直接 import 的 JS 模块：
 *   leaderboard/baselines.json  →  worker/src/assets.js (baselines)
 *   leaderboard/public/index.html →  worker/src/assets.js (pageHtml)
 * 这样 Node 测试和 wrangler 打包读的是同一份内容，也不会漂移（测试会校验一致性）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "..");

const baselines = JSON.parse(fs.readFileSync(path.join(REPO, "leaderboard", "baselines.json"), "utf8"));
const pageHtml = fs.readFileSync(path.join(REPO, "leaderboard", "public", "index.html"), "utf8");

const out = `/* 自动生成，勿手改：node worker/scripts/sync-assets.mjs */
export const baselines = ${JSON.stringify(baselines, null, 2)};

export const pageHtml = ${JSON.stringify(pageHtml)};
`;

const target = path.join(ROOT, "src", "assets.js");
fs.writeFileSync(target, out);
console.log(`已生成 ${path.relative(REPO, target)}（baselines v${baselines.suite}，页面 ${pageHtml.length} 字节）`);
