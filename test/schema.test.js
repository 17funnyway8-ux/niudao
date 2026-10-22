import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeAlias, validateSubmission } from "../src/shared/schema.js";

const good = () => ({
  suite: "1.0.0",
  client: "1.0.0",
  fingerprint: "a1b2c3d4e5f60718",
  arch: "x64",
  alias: "老王",
  hardware: { cpu_model: "AMD Ryzen 7 5825U", cores: 8, threads: 16, mem_gb: 61, os_version: "1.2.0401", kernel: "6.1.0" },
  metrics: {
    cpu_single: 1785.9,
    cpu_multi: 14656.9,
    crypto_aes: 1239.9,
    zlib: 137.6,
    mem_copy: 17.69,
    mem_latency: 108,
    disk_seq_read: 406.6,
    disk_seq_write: 200.7,
    disk_rand_read: 6316,
    disk_rand_write: 9142,
  },
});

test("合法提交通过校验并保留全部指标", () => {
  const r = validateSubmission(good());
  assert.ok(r.ok, r.errors.join(";"));
  assert.equal(Object.keys(r.value.metrics).length, 10);
  assert.equal(r.value.alias, "老王");
});

test("缺少指标 → 少于 4 项直接拒绝", () => {
  const b = good();
  b.metrics = { cpu_single: 1000 };
  const r = validateSubmission(b);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /少于 4 项/);
});

test("伪造的超大分数被可信区间挡住", () => {
  const b = good();
  b.metrics.disk_rand_read = 900_000_000;
  const r = validateSubmission(b);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /超出可信区间/);
});

test("非法指纹 / 架构 / 套件版本被拒", () => {
  const bad = (patch) => validateSubmission({ ...good(), ...patch });
  assert.equal(bad({ fingerprint: "xyz" }).ok, false);
  assert.equal(bad({ arch: "mips" }).ok, false);
  assert.equal(bad({ suite: "v1" }).ok, false);
  assert.equal(bad({ hardware: { ...good().hardware, threads: 0 } }).ok, false);
});

test("花名清洗：去标签、限长、去控制字符", () => {
  assert.equal(sanitizeAlias("<script>x</script>"), "scriptxscript");
  assert.equal(sanitizeAlias("a".repeat(40)).length, 16);
  assert.equal(sanitizeAlias("正常名字"), "正常名字");
  assert.equal(sanitizeAlias(undefined), "");
});

test("metrics 里的非数字/NaN 被丢弃而不是变成 NaN 入库", () => {
  const b = good();
  b.metrics.zlib = "很快";
  b.metrics.mem_copy = Number.NaN;
  const r = validateSubmission(b);
  assert.ok(r.ok);
  assert.equal(r.value.metrics.zlib, undefined);
  assert.equal(r.value.metrics.mem_copy, undefined);
});
