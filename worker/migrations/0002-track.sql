-- 迁移：给已存在的线上库补上赛道列（v2.4.0）
-- 新建库不需要跑这个 —— 列已经写在 schema.sql 的 CREATE TABLE 里。
-- 注意：D1 的 ALTER 不幂等，重复执行会报 "duplicate column name"，忽略即可。
ALTER TABLE entries ADD COLUMN env_type TEXT;
ALTER TABLE entries ADD COLUMN vm_tech TEXT;
CREATE INDEX IF NOT EXISTS idx_entries_track ON entries (suite, arch, env_type, composite DESC);
