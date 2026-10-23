-- 牛刀天梯 · D1 表结构
-- 用法：npx wrangler d1 execute niudao-lb --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  suite       TEXT NOT NULL,
  client      TEXT,
  fingerprint TEXT NOT NULL,
  arch        TEXT NOT NULL,
  alias       TEXT,
  hardware    TEXT NOT NULL,   -- JSON
  metrics     TEXT NOT NULL,   -- JSON（原始指标，服务端重算分数的依据）
  scores      TEXT NOT NULL,   -- JSON（服务端算出来的分）
  composite   REAL NOT NULL,
  cpu         REAL,
  memory      REAL,
  storage     REAL,
  caveats     TEXT,
  UNIQUE (fingerprint, suite)  -- 一台机器一个套件版本只留一条（最好成绩）
);

CREATE INDEX IF NOT EXISTS idx_entries_rank ON entries (suite, arch, composite DESC);
CREATE INDEX IF NOT EXISTS idx_entries_cpu ON entries (suite, arch, cpu DESC);
CREATE INDEX IF NOT EXISTS idx_entries_mem ON entries (suite, arch, memory DESC);
CREATE INDEX IF NOT EXISTS idx_entries_disk ON entries (suite, arch, storage DESC);
CREATE INDEX IF NOT EXISTS idx_entries_fp ON entries (fingerprint);
