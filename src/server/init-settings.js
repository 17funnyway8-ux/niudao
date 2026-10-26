#!/usr/bin/env node
/** 安装向导 → settings.json。参数全部走环境变量，避免用户输入进 shell。 */
import fs from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("用法: init-settings.js <settings.json 路径>");
  process.exit(1);
}

// 向导问两件事：磁盘测试文件大小、测完是否自动提交。
// 花名固定用设备名、榜单地址随包写死，都不再由安装期写入。
const disk = Number(process.env.W_DISK) || 0;
// "0" 是有效值（用户选择关闭），不能用 || 兜底，否则关不掉
const autoRaw = String(process.env.W_AUTO ?? "").trim();
const autoSubmit = autoRaw === "0" ? false : autoRaw === "1" ? true : null;

let current = {};
try {
  current = JSON.parse(fs.readFileSync(target, "utf8"));
} catch {
  current = {};
}

const next = { ...current };
if (disk >= 64 && disk <= 4096) next.diskSizeMb = disk;
if (autoSubmit !== null) next.autoSubmit = autoSubmit;

fs.mkdirSync(String(target).replace(/\/[^/]+$/, ""), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
console.log(`settings.json 已初始化: disk=${next.diskSizeMb || 512} autoSubmit=${next.autoSubmit ?? "(默认)"}`);
