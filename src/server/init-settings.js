#!/usr/bin/env node
/** 安装向导 → settings.json。参数全部走环境变量，避免用户输入进 shell。 */
import fs from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("用法: init-settings.js <settings.json 路径>");
  process.exit(1);
}

const clean = (s) => String(s || "").replace(/[<>"'`\\/]/g, "").trim();
const alias = clean(process.env.W_ALIAS).slice(0, 16);
const rawUrl = String(process.env.W_LB || "").trim();
const url = /^https?:\/\/\S+$/i.test(rawUrl) ? rawUrl : "";
const disk = Number(process.env.W_DISK) || 0;

let current = {};
try {
  current = JSON.parse(fs.readFileSync(target, "utf8"));
} catch {
  current = {};
}

const next = { ...current };
if (alias) next.alias = alias;
if (url) next.leaderboardUrl = url;
if (disk >= 64 && disk <= 4096) next.diskSizeMb = disk;

fs.mkdirSync(String(target).replace(/\/[^/]+$/, ""), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
console.log(`settings.json 已初始化: alias=${next.alias || "(空)"} disk=${next.diskSizeMb || 512} leaderboard=${next.leaderboardUrl || "(未配置)"}`);
