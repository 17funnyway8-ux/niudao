/** 本机历史：JSONL 追加写，读时全量加载（家用规模足够，且便于直接备份/查看）。 */
import fs from "node:fs";
import { ensureDataDir, PATHS } from "./settings.js";

export function appendResult(result) {
  ensureDataDir();
  fs.appendFileSync(PATHS.history, `${JSON.stringify(result)}\n`);
  return result;
}

export function readAll() {
  ensureDataDir();
  let raw = "";
  try {
    raw = fs.readFileSync(PATHS.history, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过损坏行，不影响其它记录 */
    }
  }
  return out;
}

/** 新到旧 */
export function listResults(limit = 50) {
  return readAll()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind || "fast",
      suite: r.suite,
      composite: r.scores?.composite ?? 0,
      dims: r.scores?.dims ?? {},
      grade: r.grade?.grade ?? "",
      cpu_model: r.hardware?.cpu_model ?? "",
      arch: r.arch,
      submitted: Boolean(r.submitted),
      partial: Boolean(r.scores?.partial),
      verdict: r.stability?.verdict?.headline ?? "",
      verdictLevel: r.stability?.verdict?.level ?? "",
      maxTempC: r.stability?.temp?.maxC ?? null,
    }));
}

export function getResult(id) {
  return readAll().find((r) => r.id === id) ?? null;
}

export function deleteResult(id) {
  const all = readAll();
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

function writeAll(list) {
  const body = list.map((r) => JSON.stringify(r)).join("\n");
  const tmp = `${PATHS.history}.tmp`;
  fs.writeFileSync(tmp, body ? `${body}\n` : "");
  fs.renameSync(tmp, PATHS.history);
}

export function updateResult(id, patch) {
  const all = readAll();
  let hit = null;
  const next = all.map((r) => {
    if (r.id !== id) return r;
    hit = { ...r, ...patch };
    return hit;
  });
  if (!hit) return null;
  writeAll(next);
  return hit;
}

/** 本机内的相对排名（没有排行榜服务器时的"迷你榜"）。只算快速档成绩。 */
export function localRank(composite) {
  const all = readAll()
    .filter((r) => (r.kind || "fast") === "fast")
    .map((r) => r.scores?.composite ?? 0)
    .filter((n) => n > 0);
  if (!all.length) return null;
  const better = all.filter((n) => n > composite).length;
  return { total: all.length, better, best: Math.max(...all) };
}
