/**
 * 边缘 IP 优选的选择逻辑测试（不联网）。
 *
 * 关键点：钉住 IP 只能作用于官方榜主机名，而且必须同时兼容 Node 的两种 lookup 调用方式
 * —— `{all:true}` 要回数组，否则会回 (address, family)。这里回错了会让所有请求
 * 连到错误地址或者直接抛错，所以值得单独测。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const edge = await import("../src/server/edge.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "niudao-edge-"));
const file = path.join(dir, "cf-edge.json");
const HOST = "fnbench.example.test";
const IP = "203.0.113.7";

test("落盘的选择能被读回来，且只对目标主机名生效", () => {
  fs.writeFileSync(file, JSON.stringify({ host: HOST, ip: IP, at: Date.now() }));
  edge.configureEdge({ host: HOST, file });
  assert.equal(edge.loadChoice(), IP);
  assert.equal(edge.pinnedEdge(), IP);
  assert.equal(edge.shouldPin(HOST), true);
  assert.equal(edge.shouldPin("leaderboard.internal"), false);
});

test("lookup 命中时返回钉住的 IP：普通调用与 {all:true} 两种形态都对", async () => {
  const plain = await new Promise((resolve) => edge.lookup(HOST, {}, (err, address, family) => resolve({ err, address, family })));
  assert.equal(plain.address, IP);
  assert.equal(plain.family, 4);

  const all = await new Promise((resolve) => edge.lookup(HOST, { all: true }, (err, address) => resolve({ err, address })));
  assert.ok(Array.isArray(all.address), "{all:true} 必须回数组，否则 net.connect 会崩");
  assert.equal(all.address[0].address, IP);
  assert.equal(all.address[0].family, 4);
});

test("非目标主机名走正常 DNS", async () => {
  const r = await new Promise((resolve) => edge.lookup("localhost", {}, (err, address) => resolve({ err, address })));
  assert.ok(r.address, "localhost 应该能被解析");
  assert.notEqual(r.address, IP);
});

test("文件和主机名不匹配时不采用旧选择", () => {
  fs.writeFileSync(file, JSON.stringify({ host: "stale.example.test", ip: "198.51.100.9", at: Date.now() }));
  edge.configureEdge({ host: HOST, file });
  assert.equal(edge.loadChoice(), null);
  assert.equal(edge.pinnedEdge(), null);
});

test("清掉选择后不再钉 IP", () => {
  fs.writeFileSync(file, JSON.stringify({ host: HOST, ip: IP, at: Date.now() }));
  edge.configureEdge({ host: HOST, file });
  edge.loadChoice();
  edge.clearChoice();
  assert.equal(edge.shouldPin(HOST), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
