/**
 * 版本一致性测试。
 *
 * 真实事故：2.7.0 发过一次之后又改了频率口径、睿频识别、文案，却忘了升版本，
 * 结果同一个 2.7.0 下有两个内容完全不同的包 —— 用户装第二遍时飞牛认为是同一版本，
 * 而且谁也分不清手上那个 2.7.0 是哪一版。
 *
 * 这里锁住"版本号只有一个真相"：manifest / package.json / CLIENT_VERSION
 * 三处必须一致，且基准文件里记录的客户端版本也要跟上。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const manifestVersion = (read("package/manifest").match(/^version\s*=\s*(\S+)$/m) || [])[1];
const pkgVersion = JSON.parse(read("package.json")).version;
const clientVersion = (read("src/shared/scoring.js").match(/export const CLIENT_VERSION = "([^"]+)"/) || [])[1];
const baselines = JSON.parse(read("src/server/data/baselines.json"));

test("版本号三处必须一致（manifest / package.json / CLIENT_VERSION）", () => {
  assert.ok(manifestVersion, "manifest 里找不到 version");
  assert.equal(pkgVersion, manifestVersion, `package.json 是 ${pkgVersion}，manifest 是 ${manifestVersion}`);
  assert.equal(clientVersion, manifestVersion, `CLIENT_VERSION 是 ${clientVersion}，manifest 是 ${manifestVersion}`);
});

test("版本号格式合法（x.y.z，纯数字）", () => {
  assert.match(manifestVersion, /^\d+\.\d+\.\d+$/, `版本号格式不对：${manifestVersion}`);
});

test("基准文件记录的客户端版本要与当前版本同步", () => {
  // 不同步会导致「关于」页和榜单里的版本信息对不上，排查问题时误导人
  assert.equal(baselines.client, manifestVersion, `baselines.client 是 ${baselines.client}，应为 ${manifestVersion}`);
});

test("套件版本独立于客户端版本，且格式合法", async () => {
  const { SUITE_VERSION } = await import("../src/shared/scoring.js");
  assert.match(SUITE_VERSION, /^\d+\.\d+\.\d+$/, `套件版本格式不对：${SUITE_VERSION}`);
  assert.equal(baselines.suite, SUITE_VERSION, `baselines.suite 是 ${baselines.suite}，应为 ${SUITE_VERSION}`);
  // 客户端与套件是两条版本线，不该强行相等（套件只在评分口径变化时才动）
  assert.ok(typeof manifestVersion === "string");
});
