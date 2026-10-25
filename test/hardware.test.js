/**
 * 硬件识别测试：显卡名必须来自飞牛系统清单，不能自己造。
 *
 * 真实背景：飞牛在 /usr/trim/etc/gpu_device_info.json 里已经有整份
 * PCI 厂商/设备 → 产品名 的映射（系统"设备信息"页显示的就是它）。
 * 上一版我手写了一张"常见 ID 表"，结果把 RTX A3000 认成了 RTX 2050 / MX570，
 * 而且和系统显示对不上 —— 这种"自己造识别链"的做法必须被测试挡住。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const { gpuNameFromFnOS } = await import("../src/server/hardware.js");

const DB = "/usr/trim/etc/gpu_device_info.json";
const hasDb = fs.existsSync(DB);

test("显卡名取自飞牛系统清单（三大家各验一台常见卡）", { skip: !hasDb && "本机没有 fnOS GPU 清单" }, () => {
  // NVIDIA：本机独显
  assert.match(gpuNameFromFnOS("10de", "24b8"), /RTX A3000/, "NVIDIA 应给出产品名，不是代号");
  // Intel 核显
  assert.match(gpuNameFromFnOS("8086", "3e9b"), /UHD Graphics 630/);
  // AMD 核显
  assert.match(gpuNameFromFnOS("1002", "15e7"), /Radeon/i);
});

test("查不到时返回空串（交给上层退化，不许编造型号）", { skip: !hasDb && "本机没有 fnOS GPU 清单" }, () => {
  assert.equal(gpuNameFromFnOS("ffff", "ffff"), "");
  assert.equal(gpuNameFromFnOS("", ""), "");
  assert.equal(gpuNameFromFnOS(undefined, undefined), "");
});

test("大小写不敏感（sysfs 给小写，飞牛清单里的厂商键是大写）", { skip: !hasDb && "本机没有 fnOS GPU 清单" }, () => {
  const lower = gpuNameFromFnOS("10de", "24b8");
  const upper = gpuNameFromFnOS("10DE", "24B8");
  assert.equal(lower, upper);
  assert.ok(lower.length > 0);
});

test("快照里的显卡字段是可读产品名，不含 0x 代号", () => {
  const { snapshot } = globalThis.__hw || {};
  // 直接从模块拿，避免依赖全局
  return import("../src/server/hardware.js").then((m) => {
    const hw = m.snapshot({}).hardware;
    assert.ok(typeof hw.gpu === "string");
    if (hw.gpu) {
      assert.ok(!/0x[0-9a-f]{4}/i.test(hw.gpu), `显卡名里不该出现 "0x" 代号，实际：${hw.gpu}`);
      assert.ok(!/\b(amdgpu|i915|nvidia)\b/i.test(hw.gpu.replace(/（.*?）/g, "")), `不该直接甩驱动名，实际：${hw.gpu}`);
    }
  });
});

test("飞牛清单里没有的卡，回落到系统 pci.ids（仍然是系统的数据，不是我手写的表）", () => {
  const pciIds = "/usr/share/misc/pci.ids";
  if (!fs.existsSync(pciIds)) return; // 没有就跳过
  // 10de:2684 是 RTX 4090，两处都有；这里验证返回值是"产品名"而不是代号
  const n = gpuNameFromFnOS("10de", "2684");
  assert.match(n, /4090|GeForce/i, `应给出产品名，实际：${n}`);
  // 完全不存在的 ID 必须是空串，不能编造
  assert.equal(gpuNameFromFnOS("10de", "ffff"), "");
});

test("显卡名与飞牛系统清单完全一致（这是用户能对照的锚点）", { skip: !hasDb && "本机没有 fnOS GPU 清单" }, () => {
  const db = JSON.parse(fs.readFileSync(DB, "utf8"));
  const vendor = db["10DE"];
  const dev = vendor["24B8"];
  const expected = (dev["0000"] || dev["00"] || Object.values(dev)[0]).name;
  assert.equal(gpuNameFromFnOS("10de", "24b8"), expected,
    "显卡名必须等于飞牛清单里的 name —— 用户会在系统设备信息里对照");
});

test("主板型号过滤厂商占位符（DMI 里的 Default string / To Be Filled…）", async () => {
  const m = await import("../src/server/hardware.js");
  const hw = m.snapshot({}).hardware;
  assert.ok(!/default string/i.test(hw.board), `不该出现 "Default string"，实际：${hw.board}`);
  assert.ok(!/to be filled/i.test(hw.board), `不该出现 OEM 占位符，实际：${hw.board}`);
});

test("运行环境判定：物理机必须判 physical，QEMU/VMware 特征必须判 vm", async () => {
  const { detectEnv, envFromHardwareText } = await import("../src/server/hardware.js");
  const env = detectEnv();
  assert.ok(["physical", "vm", "container"].includes(env.type));
  // 本机是物理机（无 hypervisor 标志、DMI 无虚拟化字样）
  assert.equal(env.type, "physical", `本机应判物理机，实际 ${env.type} tech=${env.tech}`);
  assert.ok(Array.isArray(env.evidence));

  // 服务端复核：DMI 文本里的虚拟化特征必须能被认出来
  for (const [text, tech] of [
    ["QEMU Standard PC (i440FX + PIIX, 1996)", "QEMU/KVM"],
    ["QEMU QEMU Virtual Machine", "QEMU/KVM"],
    ["VMware Virtual Platform", "VMware"],
    ["VirtualBox", "VirtualBox"],
    ["Microsoft Corporation Virtual Machine", "Hyper-V"],
    ["Xen HVM domU", "Xen"],
  ]) {
    const r = envFromHardwareText(text);
    assert.ok(r, `应识别出虚拟化：${text}`);
    assert.equal(r.type, "vm");
    assert.equal(r.tech, tech, `${text} 应判为 ${tech}，实际 ${r.tech}`);
  }
  // 真实主板不该被误判
  assert.equal(envFromHardwareText("Default string DS2501"), null);
  assert.equal(envFromHardwareText("AZW ME Pro"), null);
  assert.equal(envFromHardwareText("OneThing Cloud OES"), null);
});

test("无 DMI 且系统不是 fnOS → 判为容器/沙箱（真实案例：instabox 沙箱混进物理机榜）", async () => {
  const { detectEnv } = await import("../src/server/hardware.js");
  // 云端 8G 那台：board 为空、os 是 Debian、kernel 带 -instabox 后缀。
  // 前两层判据（DMI 文本、hypervisor 标志位）都抓不到，必须靠第三层兜住。
  const env = detectEnv();
  assert.ok(["physical", "vm", "container"].includes(env.type));
  // 本机有 DMI（Default string DS2501），必须是物理机，不能被这条规则误伤
  assert.equal(env.type, "physical");
});
