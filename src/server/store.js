/**
 * 本机成绩存储。两种后端，接口一致：
 *  - sqlite（默认，Node 22.5+ 内置 node:sqlite）：主键查询、索引排序、游标分页，1 万条也不虚；
 *  - jsonl（兜底）：老 Node 或 sqlite 不可用时，全量载入内存 + 追加写。
 * 首次启动若发现旧的 results.jsonl 而库里没数据，会自动迁移（保留原文件为 .migrated）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureDataDir, PATHS } from "./settings.js";

const SUMMARY_FIELDS = `
  id, ts, kind, suite, client, fingerprint, arch, cpu_model, mem_gb, composite,
  cpu, memory, storage, verdict, verdict_level, max_temp, submitted
`;

/** 兼容旧接口：把完整记录压成列表用的摘要 */
function toSummary(r) {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind || "fast",
    suite: r.suite,
    composite: r.scores?.composite ?? 0,
    dims: r.scores?.dims ?? {},
    grade: r.grade?.grade ?? "",
    cpu_model: r.hardware?.cpu_model ?? "",
    arch: r.arch,
    // 摘要里必须带指纹：看榜时要用它判断"哪一行是我"（花名可能重名）
    fingerprint: r.fingerprint ?? "",
    submitted: Boolean(r.submitted),
    partial: Boolean(r.scores?.partial),
    verdict: r.stability?.verdict?.headline ?? "",
    verdictLevel: r.stability?.verdict?.level ?? "",
    maxTempC: r.stability?.temp?.maxC ?? null,
  };
}

function summaryFromRow(row) {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind || "fast",
    suite: row.suite,
    composite: row.composite ?? 0,
    dims: row.composite
      ? {
          cpu: { score: row.cpu },
          memory: { score: row.memory },
          storage: { score: row.storage },
        }
      : {},
    grade: row.composite ? gradeOfComposite(row.composite) : "",
    cpu_model: row.cpu_model ?? "",
    mem_gb: row.mem_gb ?? null,
    arch: row.arch,
    fingerprint: row.fingerprint ?? "",
    submitted: Boolean(row.submitted),
    partial: false,
    verdict: row.verdict ?? "",
    verdictLevel: row.verdict_level ?? "",
    maxTempC: row.max_temp ?? null,
  };
}

function gradeOfComposite(n) {
  if (n >= 1400) return "S";
  if (n >= 1150) return "A";
  if (n >= 900) return "B";
  if (n >= 700) return "C";
  return "D";
}

/* ------------------------------------------------------------------ SQLite */

function createSqliteBackend(file) {
  // 动态 require：node:sqlite 在 22.5+ 才存在，缺失时这里直接抛，由 openStore 兜底
  const req = createRequire(import.meta.url);
  const { DatabaseSync } = req("node:sqlite");

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS results (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fast',
      suite TEXT,
      client TEXT,
      fingerprint TEXT,
      arch TEXT,
      cpu_model TEXT,
      mem_gb INTEGER,
      composite REAL,
      cpu REAL,
      memory REAL,
      storage REAL,
      verdict TEXT,
      verdict_level TEXT,
      max_temp REAL,
      submitted INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_results_ts ON results(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_results_kind_ts ON results(kind, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_results_composite ON results(composite DESC);
    CREATE INDEX IF NOT EXISTS idx_results_fp ON results(fingerprint);
  `);

  // 老数据回填：从 payload 里补出列表要用的字段
  try {
    db.exec("UPDATE results SET cpu_model = json_extract(payload, '$.hardware.cpu_model') WHERE cpu_model IS NULL");
    db.exec("UPDATE results SET mem_gb = json_extract(payload, '$.hardware.mem_gb') WHERE mem_gb IS NULL");
  } catch {
    /* 旧版本 SQLite 没有 json 函数就跳过 */
  }

  // 老库补列（SQLite 没有 IF NOT EXISTS for column）
  for (const col of ["cpu_model TEXT", "mem_gb INTEGER"]) {
    try {
      db.exec(`ALTER TABLE results ADD COLUMN ${col}`);
    } catch {
      /* 已存在 */
    }
  }

  const insert = db.prepare(`
    INSERT INTO results (id, ts, kind, suite, client, fingerprint, arch, cpu_model, mem_gb, composite, cpu, memory, storage,
                         verdict, verdict_level, max_temp, submitted, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET submitted = excluded.submitted, payload = excluded.payload
  `);

  const rowOf = (r) => [
    r.id,
    r.ts || Date.now(),
    r.kind || "fast",
    r.suite ?? null,
    r.client ?? null,
    r.fingerprint ?? null,
    r.arch ?? null,
    r.hardware?.cpu_model ?? null,
    r.hardware?.mem_gb ?? null,
    r.scores?.composite ?? null,
    r.scores?.dims?.cpu?.score ?? null,
    r.scores?.dims?.memory?.score ?? null,
    r.scores?.dims?.storage?.score ?? null,
    r.stability?.verdict?.headline ?? null,
    r.stability?.verdict?.level ?? null,
    r.stability?.temp?.maxC ?? null,
    r.submitted ? 1 : 0,
    JSON.stringify(r),
  ];

  function migrateFromJsonl(jsonlPath) {
    if (!fs.existsSync(jsonlPath)) return 0;
    const raw = fs.readFileSync(jsonlPath, "utf8");
    let n = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        insert.run(...rowOf(r));
        n += 1;
      } catch {
        /* 跳过坏行 */
      }
    }
    if (n > 0) fs.renameSync(jsonlPath, `${jsonlPath}.migrated`);
    return n;
  }

  return {
    backend: "sqlite",
    append(r) {
      insert.run(...rowOf(r));
      return r;
    },
    get(id) {
      const row = db.prepare("SELECT payload FROM results WHERE id = ?").get(id);
      return row ? JSON.parse(row.payload) : null;
    },
    update(id, patch) {
      const cur = this.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      insert.run(...rowOf(next));
      return next;
    },
    remove(id) {
      const info = db.prepare("DELETE FROM results WHERE id = ?").run(id);
      return info.changes > 0;
    },
    list(limit = 50) {
      const rows = db.prepare(`SELECT ${SUMMARY_FIELDS} FROM results ORDER BY ts DESC LIMIT ?`).all(limit);
      return rows.map(summaryFromRow);
    },
    page({ limit = 20, before = null } = {}) {
      const rows = before
        ? db.prepare(`SELECT ${SUMMARY_FIELDS} FROM results WHERE ts < ? ORDER BY ts DESC LIMIT ?`).all(before, limit + 1)
        : db.prepare(`SELECT ${SUMMARY_FIELDS} FROM results ORDER BY ts DESC LIMIT ?`).all(limit + 1);
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(summaryFromRow);
      return { items, nextCursor: hasMore ? items[items.length - 1].ts : null, total: this.count() };
    },
    count(kind = null) {
      const row = kind
        ? db.prepare("SELECT COUNT(*) AS n FROM results WHERE kind = ?").get(kind)
        : db.prepare("SELECT COUNT(*) AS n FROM results").get();
      return row?.n ?? 0;
    },
    fastScores(limit = 500) {
      return db
        .prepare("SELECT composite FROM results WHERE kind = 'fast' AND composite IS NOT NULL ORDER BY ts DESC LIMIT ?")
        .all(limit)
        .map((r) => r.composite);
    },
    prune(keepFast = 200, keepDeep = 50) {
      // 只保留最近 N 条（快速档/深度档分开算），避免无限增长
      db.prepare(
        `DELETE FROM results WHERE kind = 'fast' AND id NOT IN
           (SELECT id FROM results WHERE kind = 'fast' ORDER BY ts DESC LIMIT ?)`,
      ).run(keepFast);
      db.prepare(
        `DELETE FROM results WHERE kind = 'deep' AND id NOT IN
           (SELECT id FROM results WHERE kind = 'deep' ORDER BY ts DESC LIMIT ?)`,
      ).run(keepDeep);
    },
    migrate: migrateFromJsonl,
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/* -------------------------------------------------------------------- JSONL */

function createJsonlBackend(file) {
  let cache = null; // 懒加载后常驻内存

  const load = () => {
    if (cache) return cache;
    cache = [];
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return cache;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        cache.push(JSON.parse(line));
      } catch {
        /* 跳过坏行 */
      }
    }
    cache.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return cache;
  };

  const rewrite = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, cache.map((r) => JSON.stringify(r)).join("\n") + (cache.length ? "\n" : ""));
    fs.renameSync(tmp, file);
  };

  return {
    backend: "jsonl",
    append(r) {
      ensureDataDir();
      fs.appendFileSync(file, `${JSON.stringify(r)}\n`);
      const list = load();
      list.unshift(r);
      return r;
    },
    get(id) {
      return load().find((r) => r.id === id) ?? null;
    },
    update(id, patch) {
      const list = load();
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) return null;
      list[i] = { ...list[i], ...patch };
      rewrite();
      return list[i];
    },
    remove(id) {
      const list = load();
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      rewrite();
      return true;
    },
    list(limit = 50) {
      return load().slice(0, limit).map(toSummary);
    },
    page({ limit = 20, before = null } = {}) {
      const all = load();
      const start = before ? all.findIndex((r) => (r.ts || 0) < before) : 0;
      const slice = start < 0 ? [] : all.slice(start, start + limit + 1);
      const hasMore = slice.length > limit;
      const items = slice.slice(0, limit).map(toSummary);
      return { items, nextCursor: hasMore ? items[items.length - 1].ts : null, total: all.length };
    },
    count(kind = null) {
      const all = load();
      return kind ? all.filter((r) => (r.kind || "fast") === kind).length : all.length;
    },
    fastScores(limit = 500) {
      return load()
        .filter((r) => (r.kind || "fast") === "fast")
        .slice(0, limit)
        .map((r) => r.scores?.composite ?? 0)
        .filter((n) => n > 0);
    },
    prune(keepFast = 200, keepDeep = 50) {
      const list = load();
      const keep = (kind, n) => list.filter((r) => (r.kind || "fast") === kind).slice(0, n);
      const next = [...keep("fast", keepFast), ...keep("deep", keepDeep)].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      cache = next;
      rewrite();
    },
    migrate() {
      return 0;
    },
    close() {
      cache = null;
    },
  };
}

/* ------------------------------------------------------------------ 统一出口 */

let store = null;

export function openStore({ keepFast = 200, keepDeep = 50 } = {}) {
  if (store) return store;
  ensureDataDir();
  const dbFile = path.join(PATHS.data, "results.db");
  const jsonl = PATHS.history;

  let impl;
  try {
    impl = createSqliteBackend(dbFile);
    const migrated = impl.migrate(jsonl);
    if (migrated > 0) console.log(`[store] 已从 results.jsonl 迁移 ${migrated} 条到 SQLite`);
  } catch (e) {
    console.warn(`[store] SQLite 不可用（${e.code || e.message}），退回 JSONL 后端`);
    impl = createJsonlBackend(jsonl);
  }

  const originalAppend = impl.append.bind(impl);
  let counter = 0;
  impl.append = (r) => {
    const out = originalAppend(r);
    counter += 1;
    if (counter % 20 === 0) {
      try {
        impl.prune(keepFast, keepDeep);
      } catch {
        /* 清理失败不影响主流程 */
      }
    }
    return out;
  };
  store = impl;
  return store;
}

/* 兼容旧调用点的薄封装 */
export const appendResult = (r) => openStore().append(r);
export const listResults = (limit = 50) => openStore().list(limit);
export const getResult = (id) => openStore().get(id);
export const deleteResult = (id) => openStore().remove(id);
export const updateResult = (id, patch) => openStore().update(id, patch);

export function pageResults(opts) {
  return openStore().page(opts);
}

export function localRank(composite) {
  const scores = openStore().fastScores(500);
  if (!scores.length) return null;
  return {
    total: scores.length,
    better: scores.filter((n) => n > composite).length,
    best: Math.max(...scores),
  };
}

export function storageInfo() {
  const s = openStore();
  return {
    backend: s.backend,
    file: s.backend === "sqlite" ? path.join(PATHS.data, "results.db") : PATHS.history,
    total: s.count(),
    fast: s.count("fast"),
    deep: s.count("deep"),
  };
}

/* ------------------------------------------------- 反馈（本机留档） */

const FEEDBACK_FILE = () => path.join(PATHS.data, "feedback.jsonl");

/** 追加一条反馈留档。连不上云端时这就是唯一副本，所以写失败要让它冒出来。 */
export function appendFeedback(entry) {
  ensureDataDir();
  fs.appendFileSync(FEEDBACK_FILE(), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function listFeedback(limit = 30) {
  try {
    return fs
      .readFileSync(FEEDBACK_FILE(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.received_at - a.received_at)
      .slice(0, limit);
  } catch {
    return [];
  }
}
