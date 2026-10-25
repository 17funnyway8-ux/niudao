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

-- 用户反馈（含脱敏日志）。只存脱敏后的文本，不存原始日志。v1.3.0 起
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  version     TEXT,
  fs_os       TEXT,
  arch        TEXT,
  cpu_model   TEXT,
  mem_gb      REAL,
  contact     TEXT,
  message     TEXT NOT NULL,
  report      TEXT,            -- 完整反馈包（服务端已二次脱敏）
  ctx         TEXT,            -- 页面现场（哪一页、点了什么、报了什么错）
  ip          TEXT             -- 仅用于限流，不对外展示
);

CREATE INDEX IF NOT EXISTS idx_feedback_time ON feedback (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_ip ON feedback (ip, received_at DESC);

-- 赛道隔离：物理机 / 虚拟机分开排名（v2.4.0 起）
-- 虚拟机的 CPU/内存/磁盘全是宿主机的，磁盘还常被页缓存放大，混在一起比没有意义。
ALTER TABLE entries ADD COLUMN env_type TEXT;   -- physical / vm / container
ALTER TABLE entries ADD COLUMN vm_tech TEXT;    -- QEMU/KVM、VMware、Hyper-V…
CREATE INDEX IF NOT EXISTS idx_entries_track ON entries (suite, arch, env_type, composite DESC);
