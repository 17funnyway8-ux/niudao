/** 路径与配置。数据目录由 cmd/main 通过 NIUDAO_DATA 注入（=$TRIM_PKGVAR），本地开发时落到 ./.data。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_LEADERBOARD } from "../shared/endpoints.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, "..", ".."); // 开发时=项目根，打包后=app/server
export const DATA_DIR = process.env.NIUDAO_DATA || path.join(APP_ROOT, ".data");
export const TARGET_DIR = process.env.NIUDAO_TARGET || DATA_DIR;

export const PATHS = {
  data: DATA_DIR,
  target: TARGET_DIR,
  history: path.join(DATA_DIR, "results.jsonl"),
  settings: path.join(DATA_DIR, "settings.json"),
  // 最后一次成功拉到的榜单：冷启动先拿它铺屏，再后台更新（CF 链路首次握手可能要几秒）
  boardCache: path.join(DATA_DIR, "board-cache.json"),
  // 优选出来的 CF 边缘 IP（重启不用重探）
  edge: path.join(DATA_DIR, "cf-edge.json"),
  baselines: path.join(HERE, "data", "baselines.json"),
};

/**
 * 默认花名 = 主机名。
 * 绝大多数用户懒得填名字，留空会让榜上一片"匿名机器"；主机名天然可读、
 * 也符合"这就是我那台 NAS"的直觉。用户在设置里随时能改。
 */
export function defaultAlias() {
  try {
    const name = os.hostname().split(".")[0].trim();
    return name ? name.slice(0, 16) : "";
  } catch {
    return "";
  }
}

export const DEFAULT_SETTINGS = {
  alias: defaultAlias(),
  // 榜单地址写死：不再让用户填。想接自建榜的服务端可以改这个常量后重新打包；
  // 测试/离线环境可以用 NIUDAO_LEADERBOARD 临时指向本地服务（不暴露给界面）。
  leaderboardUrl: process.env.NIUDAO_LEADERBOARD || OFFICIAL_LEADERBOARD,
  leaderboardToken: "",
  // 默认自动提交：测完就能看到自己的名次，这是这个应用的核心体验
  autoSubmit: true,
  diskSizeMb: 512,
  targetDir: TARGET_DIR,
};

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadSettings() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.settings, "utf8"));
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    // 榜单地址已经写死：存量配置里的旧值（或被人手改的值）一律以常量覆盖
    merged.leaderboardUrl = DEFAULT_SETTINGS.leaderboardUrl;
    if (!merged.alias) merged.alias = defaultAlias();
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  ensureDataDir();
  const next = { ...loadSettings(), ...patch };
  const tmp = `${PATHS.settings}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, PATHS.settings);
  return next;
}

let baselineCache = null;
export function loadBaselines() {
  if (baselineCache) return baselineCache;
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.baselines, "utf8"));
    baselineCache = raw;
    return raw;
  } catch {
    baselineCache = { suite: "0.0.0", metrics: {}, machine: {}, note: "缺少基准文件" };
    return baselineCache;
  }
}
