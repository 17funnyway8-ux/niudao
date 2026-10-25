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

test("发布者/开发者外链格式合法（应用中心会直接渲染成可点链接）", () => {
  const manifest = read("package/manifest");
  for (const key of ["maintainer_url", "distributor_url"]) {
    const m = manifest.match(new RegExp(`^${key}\\s*=\\s*(\\S+)$`, "m"));
    if (!m) continue;
    const url = m[1];
    assert.match(url, /^https:\/\/\S+$/, `${key} 必须是 https 链接，实际：${url}`);
    // manifest 是 key=value，# 之后会被当注释截断 —— 带 fragment 的链接会被悄悄破坏
    assert.ok(!url.includes("#"), `${key} 不能带 #（manifest 会把 # 之后当注释截掉），实际：${url}`);
    assert.ok(url.length > 20 && url.length < 300, `${key} 长度异常：${url.length}`);
  }
});

test("公众号 __biz 必须一致（manifest 用合集链接、应用内用主页链接，但得是同一个号）", () => {
  const manifestUrl = (read("package/manifest").match(/^distributor_url\s*=\s*(\S+)$/m) || [])[1];
  const appJs = read("src/web/app.js");
  const biz = (appJs.match(/const MP_BIZ = "([^"]+)"/) || [])[1];
  assert.ok(manifestUrl, "manifest 缺 distributor_url");
  assert.ok(biz, "app.js 里找不到 MP_BIZ");

  const bizOf = (u) => (String(u).match(/__biz=([A-Za-z0-9+/=]+)/) || [])[1];
  assert.equal(bizOf(manifestUrl), biz, `manifest 的公众号 __biz 与应用内不一致：${bizOf(manifestUrl)} vs ${biz}`);
  // 应用内二维码指向的必须是主页链接（扫码直达关注），不是合集页
  assert.match(appJs, /profile_ext\?action=home/, "二维码应指向公众号主页");
});
