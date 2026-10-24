import assert from "node:assert/strict";
import { test } from "node:test";
import * as schema from "../src/shared/schema.js";

const { sanitizeAlias, validateSubmission } = schema;

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

test("别名与硬件文本清洗：去掉控制字符、零宽/双向符，防止伪造日志与显示混淆", () => {
  const { cleanText } = schema;
  assert.equal(sanitizeAlias('x\r\n{"injected":true}'), 'x{injected:true}', "换行必须去掉，否则能伪造 JSONL 记录");
  assert.equal(sanitizeAlias("a\u0000b"), "ab");
  assert.equal(sanitizeAlias("abc\u202Edef"), "abcdef", "双向覆盖符能反转显示，冒充别人");
  assert.equal(sanitizeAlias("ab\u200Bcd"), "abcd", "零宽字符能藏字");
  assert.equal(cleanText("AMD \u202Eevil<script>", 60), "AMD evilscript");
  // 中文/emoji 按字符截断，不按字节
  assert.equal(Array.from(sanitizeAlias("🐮".repeat(20))).length, 16);
});

test("提交体不接受 volume / disks：它们是本地算分用的，不该传也不该存", () => {
  // 直接构造一个"老客户端"的提交，带上卷路径与磁盘信息
  const input = {
    suite: "1.0.0",
    client: "1.3.1",
    fingerprint: "aaaabbbb11112222",
    arch: "x64",
    alias: "test",
    hardware: { cpu_model: "X", threads: 8, mem_gb: 16, volume: "/vol1/@appdata/niudao", disks: ["/vol1 btrfs 1788GB"] },
    metrics: { cpu_single: 100, cpu_multi: 200, crypto_aes: 300, zlib: 10, mem_copy: 5, mem_latency: 100, disk_seq_read: 100, disk_seq_write: 100 },
    ts: Date.now(),
  };
  const r = schema.validateSubmission(input);
  assert.equal(r.ok, true);
  assert.ok(r.value.hardware, "清洗后的 hardware 必须带回来（否则榜单拿不到 CPU 型号）");
  assert.ok(!("volume" in r.value.hardware), "volume 不能被接受");
  assert.ok(!("disks" in r.value.hardware), "disks 不能被接受");
  assert.equal(r.value.hardware.cpu_model, "X");
});
