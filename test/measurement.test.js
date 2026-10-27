/**
 * 测量正确性回归测试。
 *
 * 这三条都是内测数据暴露出来的真问题，不是假设：
 *  · Intel N150 报 10,233 MB/s、i7-8700+H310 报 13,128 MB/s —— 物理不可能
 *  · RYZEN AI MAX+ 395 延迟报 11ns、Xeon E5-2680 v4 报 20ns —— 那是缓存延迟
 *  · QD1 4K 报 169,087 IOPS —— 5.9μs 延迟，内存级速度
 * 下面把它们钉死，防止以后改回去。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("磁盘顺序写不能用全零数据（压缩文件系统会把速度放大数十倍）", () => {
  const src = read("src/server/bench/disk.js");
  // 允许 fallback 里出现 /dev/zero，但主路径必须是随机种子
  assert.ok(src.includes("makeSeed"), "缺少随机种子生成");
  assert.ok(src.includes("fillWithSeed"), "缺少用种子填充文件的实现");
  assert.ok(src.includes("/dev/urandom"), "种子必须来自 /dev/urandom");
  assert.ok(src.includes("if=/dev/zero"), "fallback 保留全零是允许的");
  // 有种子时走 fillWithSeed，没有种子才退回全零（fallback 允许，但必须留 caveat）
  const branch = src.slice(src.indexOf("if (seed) {"), src.indexOf("} else {", src.indexOf("if (seed) {")));
  assert.ok(branch.includes("fillWithSeed"), "有种子时必须用种子写");
  assert.ok(!branch.includes("if=/dev/zero"), "有种子时不能退化成全零");
  assert.ok(/无法生成随机种子/.test(src), "种子失败要留下 caveat，不能静默降级");
});

test("4K 随机测试文件也不能写全零", () => {
  const py = read("src/server/bench/random4k.py");
  assert.ok(!/chunk\s*=\s*b"\\\\0"/.test(py), "ensure_file 不能用 b\"\\0\" 填充");
  assert.ok(py.includes("os.urandom"), "应该用随机数据填充（128KB 块内高熵即不可压缩）");
});

test("内存延迟环必须按 L3 容量放大（否则 L3≥32MB 的 CPU 测成缓存延迟）", () => {
  const src = read("src/server/bench/memory.js");
  assert.ok(src.includes("pickLatencySizeMb"), "缺少按 L3 定环大小的函数");
  assert.ok(src.includes("index3/size"), "应该读 CPU 的 L3 容量");
  assert.ok(/Math\.max\(32,\s*Math\.min\(64,\s*l3 \* 2\)\)/.test(src), "环应该是 max(32, min(64, 2×L3))");
  // compute-worker 必须真的用上它
  const worker = read("src/server/bench/compute-worker.js");
  assert.ok(/memLatency\(\{\s*sizeMb:\s*pickLatencySizeMb\(\)/.test(worker), "compute-worker 没有使用动态环大小");
});

test("memLatency 收到非法参数必须报错，不能静默返回假数据", async () => {
  const { memLatency } = await import("../src/server/bench/memory.js");
  assert.throws(() => memLatency({ sizeMb: "abc" }), /sizeMb 非法/, "字符串参数应该被拦住");
  assert.throws(() => memLatency({ sizeMb: -1 }), /sizeMb 非法/);
  assert.throws(() => memLatency({ sizeMb: 32, steps: 0 }), /steps 非法/);
  // 两种调用方式都要能跑（位置参数 / 对象参数）
  const a = memLatency(4, 100_000);
  const b = memLatency({ sizeMb: 4, steps: 100_000 });
  assert.ok(a.ns > 0 && b.ns > 0);
});

test("延迟随工作集增大而变慢（缓存 → 内存的台阶必须存在）", async () => {
  const { memLatency, pickLatencySizeMb } = await import("../src/server/bench/memory.js");
  const small = memLatency(2, 400_000).ns;
  const big = memLatency(pickLatencySizeMb(), 400_000).ns;
  assert.ok(small > 0 && big > 0);
  assert.ok(big > small * 1.5, `越过缓存后延迟应明显变慢：2MB=${small}ns, ${pickLatencySizeMb()}MB=${big}ns`);
});

test("4K 随机靠延迟判定真假，而不是靠 IOPS 数值封顶", async () => {
  const { computeScores, PHYSICAL_MAX, MIN_STORAGE_LAT_US } = await import("../src/shared/scoring.js");
  const base = JSON.parse(read("src/server/data/baselines.json")).metrics;

  // ① 封顶必须够高，不能误伤 Optane 这类 QD1 能到 40–60k 的真盘
  assert.ok(PHYSICAL_MAX.disk_rand_read >= 60000, `封顶应 ≥60000 才不误伤 Optane，实际 ${PHYSICAL_MAX.disk_rand_read}`);

  // ② 真实高端盘（Optane 50k @20μs）必须正常计分、不被封顶
  const optane = computeScores({ ...base, disk_rand_read: 50000, disk_rand_read_lat_us: 20 }, base);
  assert.deepEqual(optane.cacheSuspects, [], "Optane 不该被判为缓存");
  assert.ok(optane.dims.storage.score > 2000, `Optane 存储分应显著高于基准，实际 ${optane.dims.storage.score}`);

  // ③ 虚机/页缓存（169k @5.9μs）必须被剔除
  const vm = computeScores({ ...base, disk_rand_read: 169087, disk_rand_read_lat_us: 5.9 }, base);
  assert.equal(vm.cacheSuspects.length, 1, "低延迟高 IOPS 应被判为缓存");
  assert.equal(vm.cacheSuspects[0].key, "disk_rand_read");
  assert.equal(vm.subs.disk_rand_read, undefined, "被判缓存的项不该出现在 subs 里");
  assert.equal(vm.partial, true, "有项被剔除时报告要标注不完整");

  // ④ 真实 SATA（6300 @120μs）不受影响
  const sata = computeScores({ ...base, disk_rand_read: 6300, disk_rand_read_lat_us: 120 }, base);
  assert.deepEqual(sata.cacheSuspects, [], "真实磁盘不该被误判");
  assert.ok(Math.abs(sata.dims.storage.score - 1000) < 50, "真实磁盘应接近基准分");

  // ⑤ 物理下限本身要合理（Optane 约 10μs，低于它不可能是持久化存储）
  assert.ok(MIN_STORAGE_LAT_US >= 8 && MIN_STORAGE_LAT_US <= 15, `延迟下限应在 Optane 量级，实际 ${MIN_STORAGE_LAT_US}μs`);
});

test("4K 延迟要随 IOPS 一起上报，否则延迟判据失效", () => {
  const schema = read("src/shared/schema.js");
  assert.ok(schema.includes("disk_rand_read_lat_us"), "schema 必须放行延迟字段");
  const runner = read("src/server/runner.js");
  assert.ok(/metrics\.disk_rand_read_lat_us\s*=/.test(runner), "runner 必须把延迟写进 metrics");
});
