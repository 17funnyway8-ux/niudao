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

test("4K 随机 IOPS 封顶收到 30000（QD1 的真实物理上限）", async () => {
  const { capOf } = await import("../src/shared/scoring.js");
  const base = JSON.parse(read("src/server/data/baselines.json")).metrics;
  const capRead = capOf("disk_rand_read", base);
  const capWrite = capOf("disk_rand_write", base);
  assert.ok(capRead < 5000, `读封顶分应低于 5000，实际 ${capRead}（50000 IOPS 会放到 7937）`);
  assert.ok(capWrite < 4000, `写封顶分应低于 4000，实际 ${capWrite}`);
});

test("ARM 未收录的 part 号不该原样甩给用户看", () => {
  const src = read("src/server/hardware.js");
  assert.ok(!src.includes("`Part${part}`"), "不能直接显示 Part0x000 这种代号");
  assert.ok(src.includes("型号未公开"), "应该用可读的说法替代");
});
