/** 路径与配置。数据目录由 cmd/main 通过 NIUDAO_DATA 注入（=$TRIM_PKGVAR），本地开发时落到 ./.data。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, "..", ".."); // 开发时=项目根，打包后=app/server
export const DATA_DIR = process.env.NIUDAO_DATA || path.join(APP_ROOT, ".data");
export const TARGET_DIR = process.env.NIUDAO_TARGET || DATA_DIR;

export const PATHS = {
  data: DATA_DIR,
  target: TARGET_DIR,
  history: path.join(DATA_DIR, "results.jsonl"),
  settings: path.join(DATA_DIR, "settings.json"),
  baselines: path.join(HERE, "data", "baselines.json"),
};

export const DEFAULT_SETTINGS = {
  alias: "",
  leaderboardUrl: "",
  leaderboardToken: "",
  autoSubmit: false,
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
    return { ...DEFAULT_SETTINGS, ...raw };
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
