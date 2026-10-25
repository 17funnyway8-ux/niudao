#!/usr/bin/env node
/** 安装向导 → settings.json。参数全部走环境变量，避免用户输入进 shell。 */
import fs from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("用法: init-settings.js <settings.json 路径>");
  process.exit(1);
}

// 向导只问磁盘测试文件大小：花名固定用设备名、榜单地址随包写死，
// 这两项不再由安装期写入（旧变量留在环境里也无害，但这里不再读）。
const disk = Number(process.env.W_DISK) || 0;

let current = {};
try {
  current = JSON.parse(fs.readFileSync(target, "utf8"));
} catch {
  current = {};
}

const next = { ...current };
if (disk >= 64 && disk <= 4096) next.diskSizeMb = disk;

fs.mkdirSync(String(target).replace(/\/[^/]+$/, ""), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
console.log(`settings.json 已初始化: disk=${next.diskSizeMb || 512}`);
