/** D1 查询层。所有分维度排序都走白名单列名，不拼用户输入。 */

/** 统一构造 WHERE 片段（值全部绑定） */
function whereClause({ suite, arch, cpu, above, equal, lt, gt } = {}) {
  const parts = [];
  const binds = [];
  if (suite) {
    parts.push("suite = ?");
    binds.push(suite);
  }
  if (arch) {
    parts.push("arch = ?");
    binds.push(arch);
  }
  if (cpu) {
    // cpu 是原始型号字符串，全部走绑定参数；这里是精确匹配，跟自托管端一致
    parts.push("json_extract(hardware, '$.cpu_model') = ?");
    binds.push(cpu);
  }
  if (Number.isFinite(above)) {
    parts.push("composite > ?");
    binds.push(above);
  }
  if (Number.isFinite(equal)) {
    parts.push("composite = ?");
    binds.push(equal);
  }
  if (Number.isFinite(lt)) {
    parts.push("composite < ?");
    binds.push(lt);
  }
  if (Number.isFinite(gt)) {
    parts.push("composite > ?");
    binds.push(gt);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", binds };
}

export async function countOf(db, opts = {}) {
  const { sql, binds } = whereClause(opts);
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM entries ${sql}`).bind(...binds).first();
  return row?.n ?? 0;
}

const ALLOWED_DIMS = new Set(["composite", "cpu", "memory", "storage"]);

export async function entriesOf(db, { dim = "composite", limit = 50, offset = 0, ...opts } = {}) {
  if (!ALLOWED_DIMS.has(dim)) throw new Error("非法维度");
  const { sql, binds } = whereClause(opts);
  // 一律降序：上方邻位用 gt + offset(ahead-1) 取"最小的那个更大值"，下方邻位用 lt + offset 0 取"最大的那个更小值"
  const order = "DESC";
  const rows = await db
    .prepare(
      `SELECT id, ts, suite, arch, alias, hardware, composite, cpu, memory, storage
         FROM entries ${sql}
        ORDER BY ${dim} ${order}, ts ASC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all();
  return rows.results ?? [];
}

/** 中位数 + 95% 置信区间（顺序统计量法，不假设分布） */
export async function medianStats(db, { dim = "composite", ...opts } = {}) {
  if (!ALLOWED_DIMS.has(dim)) throw new Error("非法维度");
  const { sql, binds } = whereClause(opts);
  const total = await countOf(db, opts);
  if (!total) return { median: null, ci: null };

  const at = async (offset) => {
    const row = await db
      .prepare(`SELECT ${dim} AS v FROM entries ${sql} ORDER BY ${dim} ASC LIMIT 1 OFFSET ?`)
      .bind(...binds, offset)
      .first();
    return row?.v ?? null;
  };

  const median = total % 2 ? await at((total - 1) / 2) : ((await at(total / 2 - 1)) + (await at(total / 2))) / 2;
  if (total < 8) return { median, ci: null };

  const k = Math.max(0, Math.floor(total / 2 - (1.96 * Math.sqrt(total)) / 2));
  const lo = await at(k);
  const hi = await at(total - 1 - k);
  return { median, ci: [lo, hi] };
}

export async function bucketsOf(db, { dim = "composite", ...opts } = {}) {
  if (!ALLOWED_DIMS.has(dim)) throw new Error("非法维度");
  const { sql, binds } = whereClause(opts);
  const rows = await db
    .prepare(`SELECT CAST(${dim} / 100 AS INTEGER) * 100 AS b, COUNT(*) AS n FROM entries ${sql} GROUP BY b ORDER BY b ASC`)
    .bind(...binds)
    .all();
  const out = {};
  for (const r of rows.results ?? []) out[String(r.b)] = r.n;
  return out;
}

export async function previousEntry(db, fingerprint, suite) {
  return db.prepare("SELECT * FROM entries WHERE fingerprint = ? AND suite = ?").bind(fingerprint, suite).first();
}

export async function upsertEntry(db, e) {
  // 同一台机器同一套件版本只保留最好成绩
  await db
    .prepare(
      `INSERT INTO entries
         (id, ts, received_at, suite, client, fingerprint, arch, alias, hardware, metrics, scores,
          composite, cpu, memory, storage, caveats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint, suite) DO UPDATE SET
         id = excluded.id,
         ts = excluded.ts,
         received_at = excluded.received_at,
         client = excluded.client,
         arch = excluded.arch,
         alias = excluded.alias,
         hardware = excluded.hardware,
         metrics = excluded.metrics,
         scores = excluded.scores,
         composite = excluded.composite,
         cpu = excluded.cpu,
         memory = excluded.memory,
         storage = excluded.storage,
         caveats = excluded.caveats
       WHERE excluded.composite > entries.composite`,
    )
    .bind(
      e.id,
      e.ts,
      e.received_at,
      e.suite,
      e.client,
      e.fingerprint,
      e.arch,
      e.alias,
      JSON.stringify(e.hardware),
      JSON.stringify(e.metrics),
      JSON.stringify(e.scores),
      e.composite,
      e.cpu,
      e.memory,
      e.storage,
      JSON.stringify(e.caveats || []),
    )
    .run();
}

export async function recentByFingerprint(db, fingerprint) {
  const rows = await db
    .prepare("SELECT id, ts, composite, suite, metrics FROM entries WHERE fingerprint = ? ORDER BY ts DESC LIMIT 50")
    .bind(fingerprint)
    .all();
  return rows.results ?? [];
}

export async function removeEntry(db, id) {
  const r = await db.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}
