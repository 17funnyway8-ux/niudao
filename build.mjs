#!/usr/bin/env node
/**
 * 构建：把 src/ 组装成飞牛应用包里的运行时目录，并按需调用 fnpack 打包。
 *   node build.mjs          只组装到 package/app/runtime
 *   node build.mjs --pack   组装 + fnpack build
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
const PKG = path.join(ROOT, "package");
const RUNTIME = path.join(PKG, "app", "runtime");

const log = (msg) => console.log(`[build] ${msg}`);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".data", "__pycache__"].includes(entry.name)) continue;
      copyDir(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

// 1) 清空并组装运行时
fs.rmSync(RUNTIME, { recursive: true, force: true });
copyDir(path.join(SRC, "server"), path.join(RUNTIME, "server"));
copyDir(path.join(SRC, "shared"), path.join(RUNTIME, "shared"));
copyDir(path.join(SRC, "web"), path.join(RUNTIME, "web"));
fs.rmSync(path.join(RUNTIME, "server", ".data"), { recursive: true, force: true });
log(`运行时已组装到 ${path.relative(ROOT, RUNTIME)}`);

// 2) 运行时本身不需要 npm 依赖，写个 package.json 明确模块类型
fs.writeFileSync(
  path.join(RUNTIME, "package.json"),
  `${JSON.stringify({ name: "niudao-runtime", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
);

// 3) 榜单服务自带一份基准（独立部署时也要能校验分数）
const baselines = path.join(SRC, "server", "data", "baselines.json");
fs.copyFileSync(baselines, path.join(ROOT, "leaderboard", "baselines.json"));
fs.mkdirSync(path.join(ROOT, "leaderboard", "data"), { recursive: true });
log("榜单基准已同步: leaderboard/baselines.json");

// 4) 可执行位（fnpack 会处理，但本地真机试跑也常直接执行）
for (const f of fs.readdirSync(path.join(PKG, "cmd"))) {
  fs.chmodSync(path.join(PKG, "cmd", f), 0o755);
}

// 5) 体检：确保包结构完整（有 .octop 技能里的检查器就顺手跑一下）
const checker = path.resolve(ROOT, "..", "..", ".octop/skills/fnos-app-dev/scripts/fnos_check.py");
if (fs.existsSync(checker)) {
  const r = spawnSync("python3", [checker, PKG], { encoding: "utf8" });
  console.log(r.stdout.trim());
  if (r.status !== 0) {
    console.error("[build] 包体检未通过，先修 FAIL 项");
    process.exit(1);
  }
}


/**
 * 版本防重：**一个版本号只能交付一次**。
 *
 * 真实事故：2.7.0 交付过之后又改了频率口径/睿频识别/文案，忘了升版本，
 * 又打出一个也叫 2.7.0 的包 —— 用户装第二遍时飞牛认为是同一版本，
 * 而且谁也分不清手上那个 2.7.0 是哪一版。
 *
 * 判据刻意不用内容 hash：fnpack 的产物里带时间戳，同样的源码两次打包 sha 也不同，
 * 用 hash 查重会把正常的重复构建全拦下来。改成看"这个版本号有没有交付出去"——
 * 开发期间随便重建，但只要 outbound 里已经有同名文件，就必须先升版本。
 */
const OUTBOUND = path.resolve(ROOT, "..", "..", "outbound");

function checkNotDelivered(version) {
  const name = `niudao_${version}.fpk`;
  const hit = path.join(OUTBOUND, name);
  if (fs.existsSync(hit)) {
    console.error(`\n[build] 版本号 ${version} 已经交付过：outbound/${name}`);
    console.error(`        改了东西就必须升版本号，否则用户装第二遍会被当成同一版本。`);
    console.error(`        请修改 package/manifest 与 package.json 的 version。\n`);
    process.exit(1);
  }
}

function recordVersion(version, file) {
  const history = path.join(PKG, ".version-history.json");
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(history, "utf8"));
  } catch {
    list = [];
  }
  if (!list.some((h) => h.version === version)) {
    list.push({ version, at: new Date().toISOString(), bytes: fs.statSync(file).size });
    fs.writeFileSync(history, `${JSON.stringify(list, null, 2)}\n`);
  }
}

// 6) 可选打包
if (process.argv.includes("--pack")) {
  const appname = (() => {
    const manifest = fs.readFileSync(path.join(PKG, "manifest"), "utf8");
    const m = manifest.match(/^appname\s*=\s*(\S+)/m);
    return m ? m[1] : "app";
  })();
  const fpk = path.join(PKG, `${appname}.fpk`);
  fs.rmSync(fpk, { force: true });

  const r = spawnSync("fnpack", ["build"], { stdio: "inherit", cwd: PKG });
  // fnpack 的退出码不可靠（打包失败也可能返回 0），以产物是否存在为准
  if (!fs.existsSync(fpk)) {
    console.error("[build] 打包失败：没生成 .fpk（看上面的 fnpack 输出；也可能是没装 fnpack）");
    process.exit(r.status || 1);
  }
  const size = (fs.statSync(fpk).size / 1024).toFixed(0);
  const version = (fs.readFileSync(path.join(PKG, "manifest"), "utf8").match(/^version\s*=\s*(\S+)/m) || [])[1] || "0.0.0";
  checkNotDelivered(version);
  recordVersion(version, fpk);
  log(`已生成 ${path.relative(ROOT, fpk)}（${size} KB · v${version}）`);
} else {
  log("完成（加 --pack 生成 .fpk）");
}
