# 牛刀 · 飞牛 fnOS 性能天梯

给飞牛 NAS 做一次**性能体检**：六项实测 → 综合分 + 维度分 → 一份能贴到论坛的报告 → 和别人的机器排进同一个天梯。

不是"又一个跑分脚本"：它是一个完整的 fnOS 原生应用（统一网关 + 生命周期脚本 + 安装向导），
外加一个零依赖、可自托管的排行榜服务。

```
体检（约 40 秒） → 分数与报告 → 提交天梯 → 看排名 / 前后一名 / 人群分布
```

## 它测什么

| 维度 | 权重 | 实测项 | 为什么这么选 |
|---|---|---|---|
| CPU 计算 | 40% | 单核整数混算、多核整数混算、AES-256-GCM、zlib | NAS 上真正吃 CPU 的活：转码、刮削、压缩、加密传输 |
| 内存 | 20% | memcpy 带宽、随机访问延迟 | 大文件搬运（带宽）与元数据/缩略图小请求（延迟） |
| 存储 I/O | 40% | 顺序读、顺序写、4K 随机读 QD1、4K 随机写 QD1 | 顺序=影音与备份；4K 随机=相册缩略图、数据库、虚拟机 |

刻意**不测**：显卡编解码、网络吞吐、功耗与噪音 —— 这些靠实测环境，跑分替代不了（报告里会说明）。

技术细节：
- 磁盘顺序测试用 `dd` + `O_DIRECT`，4K 随机用 Python + `O_DIRECT` + 页对齐缓冲，**全部绕过页缓存**，避免测成"内存速度"。
- CPU 内核固定时限、两轮取优、带 JIT 预热；多核用 `worker_threads` 并与单核做对比，得到**扩展效率**。
- 每个原始指标都可见；分数 = 实测 / 基准 × 1000，权重全部公开。

## 分数怎么理解

- **1000 = 基准机**（本仓库的校准机：AMD Ryzen 7 5825U，8 核 16 线程）。基准随套件版本锁定，跨版本不比较。
- 总分不是黑箱：CPU/内存/存储三个维度各自出榜，任一维度缺失时按已有项重新归一，并标记「部分项缺失」。
- 等级 S/A/B/C/D 只是给个直觉（S≥1400、A≥1150、B≥900、C≥700、D<700），不参与排名。

## 快速开始（开发）

需要 Node.js ≥ 22（应用运行时用 fnOS 的 `nodejs_v22`，磁盘测试需要 `python3`）。

```bash
npm run dev          # http://0.0.0.0:7788
npm test             # 38 项单测：评分模型、校验、榜单、HTTP、基准内核
node scripts/calibrate.mjs   # 在你的机器上重新校准 1000 分基准（会重写 baselines.json）
```

## 装到飞牛 fnOS

```bash
node scripts/make-icons.py   # 生成图标（已生成过可跳过）
node build.mjs --pack        # 组装运行时 + 包体检 + fnpack build → package/niudao.fpk
```

然后二选一：

- **应用中心** → 手动安装 → 选 `package/niudao.fpk`（本地测试用）
- **命令行**：`appcenter-cli install-fpk niudao.fpk`（带向导时可 `--env config.env`）

安装向导会问三件事：花名（上榜显示名）、磁盘测试文件大小、排行榜地址（可留空）。

安装后入口在桌面「牛刀」，实际访问路径 `/app/niudao`（统一网关，不占主机端口）。
日志在应用数据目录：`/var/apps/niudao/var/app.log`。

## 排行榜（自托管）

应用离线也完整可用（本机成绩 + 报告 + 成绩卡）；想要跨机器排名，就把榜单服务跑起来：

```bash
# 任意一台能跑 Node 22 的机器，或同一台 NAS
node leaderboard/server.js --port 8790
# 数据落在 leaderboard/data/submissions.jsonl
```

然后在应用「设置 → 排行榜地址」填 `http://<地址>:8790`，测完点「提交到天梯」。
榜单也自带一个网页：浏览器打开 `http://<地址>:8790` 就能看榜。

- 服务端**只接收原始指标**，分数一律用同一份 `baselines.json` 重算 —— 客户端改分数无效。
- 同一台机器（硬件指纹）只保留最好成绩；套件版本不同不混榜；架构默认分开排。
- 想删脏数据：`LB_ADMIN_TOKEN=xxx node leaderboard/server.js ...`，然后
  `curl -X DELETE -H "Authorization: Bearer xxx" .../api/v1/entry/<id>`。
- 部署细节（systemd / 反代 / 备份）见 `leaderboard/README.md`。

## 目录结构

```
src/shared/       评分模型与提交校验（应用与榜单服务共用）
src/server/       应用后端：bench 内核、编排、HTTP、本机存储、榜单客户端
src/web/          前端（零框架、零依赖，纯 ES module）
leaderboard/      自托管榜单服务（Node 标准库 + JSONL）
package/          fnOS 应用包（manifest / config / cmd / wizard / app）
  app/runtime/    ← build.mjs 从 src/ 组装出来的运行时（不提交）
scripts/          校准与图标生成
test/             node:test 单测
docs/             设计文档
```

## 边界与已知限制

- 快速档只做性能，不做 30 分钟烤机与温度曲线（那需要把机器占住更久），但会记录**测完瞬间的温度快照**与环境负载。
- 磁盘数据取决于**测试目录所在的卷**（默认是应用数据目录），HDD/SSD/RAID 差异巨大，报告里会写明测试卷。
- 榜单目前是「未校验」模式：挡住明显伪造（可信区间 + 服务端重算 + 指纹去重 + 限流），但不防决心作弊的人。真正的签名验证留作后续。
- ARM 机型走同一套代码（Node + Python 都跨架构），但基准机是 x86，ARM 分数天然偏低，所以榜单默认按架构分开排。
- 校准机是单台参考机，不是行业标准；它的作用是让"1000 分"有明确含义，而不是宣称权威。

## 上架前需要你补的

- `package/manifest` 里的 `maintainer` / `maintainer_url` 换成你自己。
- 真机验证：装得上 → 卡片打得开 → start/stop/status 正常 → 数据落在 `TRIM_PKGVAR` → 换用户看不到别人的数据。
- 若要公开发榜，建议先想清楚内容治理（花名、恶意提交、服务器成本）。
