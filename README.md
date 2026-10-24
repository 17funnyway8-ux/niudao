# 牛刀 · 飞牛 fnOS 性能天梯

给飞牛 NAS 做一次**性能体检**：六项实测 → 综合分 + 维度分 → 一份能贴到论坛的报告 → 和别人的机器排进同一个天梯。
另有一档**深度体检**：满载烤机 + 温度/频率曲线 + 降频判定，回答"这台机器能不能长期扛"。

不是"又一个跑分脚本"：它是一个完整的 fnOS 原生应用（统一网关 + 生命周期脚本 + 安装向导），
外加一个零依赖、可自托管的排行榜服务。

```
体检（约 40 秒） → 分数与报告 → 提交天梯 → 看排名 / 前后一名 / 人群分布
深度体检（1–20 分钟） → 温度与频率曲线 → 性能保持率 → 散热结论
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

## 深度体检（稳定性）

| 你选 | 它做什么 |
|---|---|
| 1 / 3 / 5 / 10 分钟 | 冷态跑 3 轮多核取最好 → 满载烤机 N 分钟（每秒采样温度/频率） → 热态再跑 3 轮取最好 |

产出：**性能保持率**（热态 / 冷态）、温度曲线、频率曲线、结论（散热合格 / 轻微衰减 / 明显降频 / 散热吃紧）。
结论只看性能保持率 —— 那才是降频的真实代价；温度与频率只作旁证。

几条刻意的设计：
- **多轮取最好**，不用单次：多核跑分对外部干扰极敏感（实测同一台机器连续 5 次能差 7%），单次对比会把噪声误判成降频。
- 可选**叠加磁盘写压力**：更接近 RAID 重建时的机箱温度，但会磨损 SSD，默认关闭。
- 温度读不到就说读不到（`capabilities` 里标 false），不编数字。
- 深度成绩**不参与性能总分**，也不进天梯 —— 它测的是持续性能，不是算力。

## 工程上做了什么（v1.1，基于横向调研）

| 主题 | 做法 | 对标 |
|---|---|---|
| 稳定性判定 | 烤机期间每 5–30s 记一轮吞吐，`稳定性 = 最差轮 ÷ 最好轮`，≥97% 合格；前 8–30s 预热不计入 | 3DMark 压力测试（97% / 20 循环） |
| 榜单公信力 | 样本 < 30 台不显示百分位；同时给中位数与 95% 置信区间（顺序统计量法）；同指纹 12 小时内只收一次，除非提升 >3% | Speedtest Global Index |
| 数字的可信度 | 每个指标多显示一列「测法」（几轮、几秒、多大文件、是否 O_DIRECT 退化）；深度报告给逐轮柱状图 | Notebookcheck（样本数 n） |
| 存储 | SQLite（`node:sqlite`，WAL）为主后端，主键查询 + 游标分页 + 保留策略（200/50 条）；老数据从 `results.jsonl` 自动迁移；Node < 22.5 自动退回 JSONL | Uptime Kuma / Beszel |
| 可观测性 | `/api/metrics`（Prometheus 文本）+ 结构化 JSON 日志（`app.jsonl`）+ `uncaughtException` 兜底 + SIGTERM 优雅退出（先停测试再退出） | Netdata / Grafana |
| 前端 | hash 深链（`#/result/<id>` 可分享可刷新）、明暗主题（跟随系统 + 手动切换）、图表十字线/tooltip/阈值线、稳定性逐轮柱图 | Grafana / Geekbench Browser |
| 体检时界面不卡 | 所有重活都在 worker 里跑（CPU 单/多核、AES、zlib、内存访存），磁盘项走异步子进程；进程内自带事件循环阻塞监控（`niudao_event_loop_lag_ms`，>800ms 记一条 warn） | 3DMark（跑分时 UI 仍可交互） |

## 分数怎么理解

- **1000 = 基准机**（本仓库的校准机：AMD Ryzen 7 5825U，8 核 16 线程）。基准随套件版本锁定，跨版本不比较。
- 总分不是黑箱：CPU/内存/存储三个维度各自出榜，任一维度缺失时按已有项重新归一，并标记「部分项缺失」。
- 等级 S/A/B/C/D 只是给个直觉（S≥1400、A≥1150、B≥900、C≥700、D<700），不参与排名。

## 快速开始（开发）

需要 Node.js ≥ 22（应用运行时用 fnOS 的 `nodejs_v22`，磁盘测试需要 `python3`）。

```bash
npm run dev          # http://0.0.0.0:7788
npm test             # 64 项单测：评分模型、校验、榜单门槛、HTTP、基准内核、稳定性分析、深度编排、存储层
node scripts/calibrate.mjs   # 在你的机器上重新校准 1000 分基准（会重写 baselines.json）
node scripts/check-deep.mjs  # 用极短时长跑一遍深度档（约 40 秒），验证温度采样链路
npm run worker:assets        # 把榜单页 + 基准编译进 worker（改了 public/index.html 后必跑）
npm run worker:dev           # 本地起 Cloudflare Worker（wrangler --local）
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

> 桌面入口走飞牛统一网关：`ui/config` 声明的 `gatewayPrefix=/app/niudao`，网关会把
> `/app/niudao/xxx` 原样转发进来，所以服务端会先剥掉这个前缀，再在首页注入
> `<base href="/app/niudao/">`；前端所有资源与接口都用相对路径。
> 少了这一步的表现是「点开应用只显示一个巨大的图标」——因为 `styles.css`、`app.js`
> 会被解析到 NAS 根上 404，页面根本渲染不出来。

## 两种榜单后端

| 后端 | 地址 | 特点 |
|---|---|---|
| Cloudflare Workers + D1 | **https://fnbench.1133891.xyz**（`worker/`） | **永久在线**、无服务器、免费额度足够；已内置为默认榜单 |
| 自托管 Node + JSONL | `leaderboard/` | 数据在自己手里，适合内网/自有 VPS |

两者 API 完全一致，客户端只改地址。当前内置的默认地址在 `src/shared/endpoints.js`，
换地址改这一行 + 重新打包即可。

> 为什么不用 `*.workers.dev`：该域在国内网络被解析污染（返回 Dropbox 的 IP），必须挂自定义域名。
> 绑自定义域名的命令：`curl -X PUT .../accounts/<id>/workers/domains -d '{"zone_id":"...","hostname":"fnbench.1133891.xyz","service":"niudao-lb","environment":"production"}'`

## 国内访问 Cloudflare 这条链路（实测与对策）

官方榜挂在 CF 免费套餐上。**一开始的判断是错的**：以为"国内到 CF 就是慢"。实测把它推翻了。

同一条家宽、同一分钟、各 4 次：

| 目标 | 成功 | 说明 |
|---|---|---|
| `www.baidu.com` | 4/4 | 宽带本身没问题 |
| `www.cloudflare.com` | 4/4 | 到 CF 也没问题 |
| `fnbench.1133891.xyz` | **1/4** | 只有我们这个域名不行 |

差别在于 **DNS 给这个 zone 分配的那两个 anycast IP**（`104.21.41.26` / `172.67.159.18`）在这条线路上建连失败率极高。
而 CF 的 anycast 有个特性：**任何 CF 边缘 IP 都能服务任何挂在 CF 上的站点**，只要 TLS SNI 和 HTTP Host 还是我们的域名。
所以客户端自己挑一个走得通的 IP 就行 —— 这就是俗称的「CF 优选 IP」，证书照样校验、路由照样到我们的 Worker。

换成 `104.17.128.1` 之后，同样的请求：

| 场景 | 成功率 | p50 | p95 |
|---|---|---|---|
| DNS 给的 IP（`--mode=seq`） | 4/4 但抖动巨大 | **4132ms** | **16767ms** |
| 钉 `104.17.128.1` + 旧策略 | 6/6 | **180ms** | 600ms |
| 钉 `104.17.128.1` + 现策略 | 6/6 | **191ms** | 580ms |
| 走应用自己的 30 秒新鲜期缓存 | 100% | **3ms** | — |

于是客户端现在做四件事：

1. **边缘 IP 优选**（`src/server/edge.js`）：启动时并发探测一小池 CF anycast IP（每个 2s），
   谁先给出正确的 `/api/v1/health` 就钉谁（SNI/Host 不变，只换解析结果）；选择落盘到
   `cf-edge.json`，重启不重探。连续 3 次网络失败会自动重探；换官方榜地址则旧选择作废。
   **只对内置官方榜生效**，用户填的自建地址一律按 DNS 走。
2. **长连接池**：`node:https` Agent + `keepAliveMsecs=30s`（undici 默认只有 4s），
   正常情况一次看榜只花一个 RTT；另外每 25 秒喂一次 `/api/v1/health` 保活
   （实测 idle 超过 ~60s 连接就退化成"半死"状态，请求会一直挂着）。
3. **对冲重试（hedged）**：首条 1.5s 短超时，没回就**并发**再发一条，后续给 6s 让新握手有机会完成，
   最多 3 条；谁先回用谁，其余立刻掐掉。业务错误（4xx/5xx）不重试。
4. **缓存三段式**：内存 30 秒新鲜期 → 磁盘 `board-cache.json`（重启后仍能秒开）→
   后台 stale-while-revalidate。**用户永远不用对着"载入中"等网络**；真连不上就退回旧数据，
   并写清楚"这是多久前的数据"。开机还会在后台先抓一份，装上应用第一次点天梯榜就是秒开。

自己验一遍：

```bash
npm run check:cf -- --mode=seq                    # 走 DNS + 旧策略（对照）
npm run check:cf -- --ip=104.17.128.1             # 钉住优选 IP
npm run check:cf -- --path=/api/v1/leaderboard?dim=overall
```

> 说明：优选 IP 是"用当下能通的边缘"。CF 的 anycast IP 会变、线路会变，
> 所以代码里有自动重探；真要绝对稳，还是国内轻量 VPS 跑同款 `leaderboard/server.js`，
> 改 `src/shared/endpoints.js` 一行指过去即可。

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

## 数据与日志在哪

| 内容 | 路径 |
|---|---|
| 成绩库 | `<数据目录>/results.db`（SQLite，WAL） |
| 旧版成绩 | `<数据目录>/results.jsonl`（首次启动自动迁移为 `.migrated`） |
| 结构化日志 | `<数据目录>/app.jsonl`（超过 2MB 轮转为 `.1`） |
| 设置 | `<数据目录>/settings.json` |
| 榜单缓存 | `<数据目录>/board-cache.json`（最后一次成功拉到的榜，冷启动用来铺屏） |
| 优选边缘 IP | `<数据目录>/cf-edge.json`（删掉就会重新探测） |
| 指标 | `GET /api/metrics`（含 `niudao_event_loop_lag_ms`：体检期间主线程有没有被卡住） |

安装后数据目录 = `/var/apps/niudao/var`。

## 目录结构

```
src/shared/       评分模型与提交校验（应用与榜单服务共用）
src/server/       应用后端：bench 内核、编排、HTTP、本机存储、榜单客户端（remote/edge）
src/web/          前端（零框架、零依赖，纯 ES module）
leaderboard/      自托管榜单服务（Node 标准库 + JSONL）
package/          fnOS 应用包（manifest / config / cmd / wizard / app）
  app/runtime/    ← build.mjs 从 src/ 组装出来的运行时（不提交）
scripts/          校准、图标生成、CF 通道体检（cf-check.mjs）
test/             node:test 单测
docs/             设计文档
```

## 边界与已知限制

- 深度档最多 20 分钟（可配到 60 分钟，但 UI 只给到 20 分钟档）：再长就属于"压力测试"而不是"体检"了。
- 温度采样依赖 sysfs：有些机器没有 CPU 温度传感器（比如部分 ARM 或屏蔽了 hwmon 的内核），这时只给频率与性能结论，并明确标注。
- 磁盘数据取决于**测试目录所在的卷**（默认是应用数据目录），HDD/SSD/RAID 差异巨大，报告里会写明测试卷。
- 榜单目前是「未校验」模式：挡住明显伪造（可信区间 + 服务端重算 + 指纹去重 + 限流），但不防决心作弊的人。真正的签名验证留作后续。
- 深度档的主判定是**逐轮吞吐稳定性**（3DMark 口径），冷/热对比降级为"加速回落"参考值。
- 榜单的百分位需要 ≥30 台样本；不足时只给名次与前后一名，不给百分比。
- ARM 机型走同一套代码（Node + Python 都跨架构），但基准机是 x86，ARM 分数天然偏低，所以榜单默认按架构分开排。
- 校准机是单台参考机，不是行业标准；它的作用是让"1000 分"有明确含义，而不是宣称权威。

## 上架前需要你补的

- `package/manifest` 里的 `maintainer` / `maintainer_url` 换成你自己。
- 真机验证：装得上 → 卡片打得开 → start/stop/status 正常 → 数据落在 `TRIM_PKGVAR` → 换用户看不到别人的数据。
- 若要公开发榜，建议先想清楚内容治理（花名、恶意提交、服务器成本）。
