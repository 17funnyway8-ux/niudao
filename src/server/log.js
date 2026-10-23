/**
 * 结构化日志：一行一个 JSON，同时写 stdout 和 <data>/app.jsonl（滚动到 2MB 后截断）。
 * 为什么不是 console.log：出问题时要能按 level / event 过滤，而不是翻一屏中文。
 */
import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 2 * 1024 * 1024;

let stream = null;
let filePath = null;
let minLevel = process.env.NIUDAO_LOG_LEVEL || "info";

export function initLogger(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    filePath = path.join(dataDir, "app.jsonl");
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_BYTES) {
      fs.renameSync(filePath, `${filePath}.1`);
    }
    stream = fs.createWriteStream(filePath, { flags: "a" });
  } catch {
    stream = null;
  }
}

function write(level, event, fields = {}) {
  if ((LEVELS[level] ?? 20) < (LEVELS[minLevel] ?? 20)) return;
  const rec = { t: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(rec);
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
  try {
    stream?.write(`${line}\n`);
  } catch {
    /* 日志写不进去不能影响主流程 */
  }
}

export const log = {
  debug: (event, fields) => write("debug", event, fields),
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
  setLevel: (lvl) => {
    if (LEVELS[lvl]) minLevel = lvl;
  },
  file: () => filePath,
};
