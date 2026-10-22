# 牛刀 · 设计文档

- 日期：2026-10-23
- 状态：已实现 v1.0.0
- 相关：`README.md`（使用）、`leaderboard/README.md`（部署）

## 1. 目标与定位

在飞牛 fnOS 上做一个**NAS 性能体检 + 天梯**：用户点一下，40 秒拿到自己机器的性能画像；
能和别人的机器比，能看到"前一名/后一名是什么机器"；报告可导出、可贴论坛。

定位不是"跑分脚本"，而是**一个能长期用的应用**：有历史成绩、有硬件档案、有可复核的分数来源、
有跨用户的榜单。价值层是体检报告，社交层是榜单。

### 已确认的产品决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 排行榜托管 | 客户端 + **附赠自托管榜单服务** | 不依赖第三方、断网也能用；有服务器就变成真榜单 |
| 测试时长 | **快速档（≤ 1 分钟）** | 首次体验门槛低；烤机/温度曲线留作后续深度档 |
| 硬件覆盖 | **x86 + ARM 都支持，默认分架构出榜** | 同一套 JS/Python 跨架构可跑，但基准机是 x86，混排会失真 |
| 榜单调性 | 参考优先、兼顾好玩 | 数据先可信（分项、权重公开、可复核），展示层给段位、人话结论、成绩卡 |

## 2. 竞品调研与取舍

| 竞品 | 强在哪 | 它的问题 | 牛刀的做法 |
|---|---|---|---|
| 3DMark / PCMark | 版本门禁、硬件监控、Hall of Fame 分层榜 | 图形/办公场景与 NAS 无关 | 借"版本门禁"：套件版本不同不混榜 |
| Geekbench Browser | 单/多核分离、网页可筛选、valid/invalid 校验 | 计时校验只在 Windows 有 | 记录原始指标 + 客户端/套件版本，服务端重算 |
| PassMark | 分项分 + 百分位 + 同型号分布 | 绝对分仍易被误读 | 展示"排名 + 百分位 + 前后一名 + 人群分布" |
| **UserBenchmark** | 聚合简单、传播快 | **单一加权总分 + 权重不透明 → 被质疑即崩**（改权重后 TR 一代从第 1 掉到 48，全网封杀） | 维度分独立出榜、权重写进代码与文档、原始值全可见 |
| CrystalDiskMark / fio | 存储测试的事实标准 | 是工具不是产品，无榜单、无解释 | 用同一套 I/O 语义（O_DIRECT、QD1 4K），但做成"一键 + 有解释" |
| YABS / nench（VPS 圈） | 一条命令出报告，社区熟 | 输出是文本，无横向比较 | 一条命令的体验保留（应用内一键），补上榜单 |
| 飞牛社区 `benchmark.sh` | 证明需求真实：CPU/内存/磁盘三项 + 上传榜单 | 要装 gotty、手动跑脚本、无硬件档案、无版本门禁、无防伪 | 原生应用、六项指标、硬件档案、服务端重算、指纹去重 |

三条硬性吸取：
1. **绝不做一个黑箱总分**。总分存在，但必须可拆解（维度 → 指标 → 归一化分），权重公开。
2. **跨版本不比较**。`SUITE_VERSION` 进榜单主键之一。
3. **NAS 的"性能"要看真实负载**。因此有 AES/zlib（加密传输与备份压缩），而不是只有整数运算。

## 3. 测量设计

### 3.1 指标

| 键 | 含义 | 单位 | 方法 |
|---|---|---|---|
| `cpu_single` | 单核整数混算 | MOps/s | xorshift 依赖链 + imul + 索引写回，固定 5s × 2 轮取优，带 JIT 预热 |
| `cpu_multi` | 多核同负载 | MOps/s | `worker_threads` × 逻辑核数，各线程自计时，按墙钟汇总 |
| `crypto_aes` | AES-256-GCM | MB/s | 32MB 块 × 8，原生 OpenSSL（反映 AES 指令集） |
| `zlib` | deflate level 6 | MB/s | 半压缩数据（≈50% 压缩率），接近备份真实负载 |
| `mem_copy` | memcpy 带宽 | GB/s | 256MB `TypedArray.set` × 5 取优 |
| `mem_latency` | 随机访问延迟 | ns | 构建 32MB 随机置换环后指针追逐 |
| `disk_seq_read` / `disk_seq_write` | 顺序读写 | MB/s | `dd bs=1M` + `O_DIRECT`（`conv=fdatasync`） |
| `disk_rand_read` / `disk_rand_write` | 4K 随机 QD1 | IOPS | Python `preadv/pwritev` + `O_DIRECT` + `mmap` 页对齐缓冲，固定 6s |

不做 `QD32`：家用 NAS 的绝大多数随机 I/O 是低队列深度的；QD32 更接近"企业盘规格表"，对用户没有解释力。

### 3.2 归一化与权重

```
sub[key] = 1000 × (raw / baseline)         # 越大越好的指标
sub[key] = 1000 × (baseline / raw)         # 越小越好的指标（mem_latency）

cpu     = 0.45·cpu_single + 0.40·cpu_multi + 0.075·crypto_aes + 0.075·zlib
memory  = 0.55·mem_copy   + 0.45·mem_latency
storage = 0.175·seq_read + 0.175·seq_write + 0.39·rand_read + 0.26·rand_write

composite = 0.40·cpu + 0.20·memory + 0.40·storage
```

- 存储占 40% 是刻意的：NAS 的主战场是 I/O，不是跑分。
- 某维度缺项时按已参与项重新归一（`coverage` 记录覆盖度），某个维度全缺则不参与综合分。
- 基准机：AMD Ryzen 7 5825U / 8C16T / 61GB，2026-10-23 实测（`scripts/calibrate.mjs` 可重跑）。

## 4. 架构

```
浏览器（fnOS 桌面 iframe）
   │  /app/niudao  （统一网关，登录态由 fnOS 校验）
   ▼
app.sock ── Node 服务（零依赖）
   ├── HTTP 层       路由、静态资源、JSON API、单实例运行状态机
   ├── 编排 runner   6 个阶段顺序执行、逐阶段上报、单阶段失败不拖垮整体
   ├── bench/*       内核（CPU/内存/加密/磁盘），可独立测试
   ├── store         本机成绩 JSONL + 排行降级
   └── remote        榜单客户端（未配置则全部降级为本地模式）
        │  HTTP
        ▼
   自托管榜单服务（Node + JSONL）
        └── 校验 → 用同一份 baselines 重算分数 → 去重入榜
```

### 关键取舍

- **零 npm 依赖**：应用包不需要 `node_modules`，安装体积小、无供应链风险、离线可用。
- **前端零框架**：`src/web` 是三个文件（html/css/js），没有构建步骤，改完刷新就生效。
- **Python 只负责 4K 随机 I/O**：需要 `O_DIRECT` + 页对齐缓冲，Node 的 `fs` 不暴露 `O_DIRECT`，
  用 `mmap` 当缓冲区解决对齐问题；找不到 python 时该项跳过并在报告里说明。
- **服务端重算分数**：客户端只交原始指标，防住"改个数字就上榜"的最常见作弊。

## 5. 数据模型

本机成绩（`results.jsonl`，一行一条）：

```json
{ "id": "uuid", "ts": 1792688713570, "suite": "1.0.0", "client": "1.0.0",
  "fingerprint": "sha256(cpu|arch|cores|threads|mem|board|machine-id)[:24]",
  "arch": "x64", "hardware": {...}, "metrics": {...}, "scores": {...},
  "grade": {...}, "durations": {...}, "detail": {...}, "caveats": [...], "submitted": false }
```

榜单条目：同样字段 + `scores`（服务端重算）+ `receivedAt`。
主键：`fingerprint + suite`（一台机器一个版本只留最好成绩）。

## 6. 接口

应用侧（`/api/*`，经统一网关）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | 一次拿全：硬件、维度定义、设置、榜单状态、历史、运行态 |
| POST | `/api/run` / `/api/run/cancel` · GET `/api/run` | 启动/中止/轮询（轮询而非 SSE，避免反代缓冲问题） |
| GET | `/api/results` · `/api/results/:id` · DELETE | 成绩单 |
| GET | `/api/results/:id/report.md` · `export.json` · `card` | 导出 |
| POST | `/api/results/:id/submit` | 提交榜单 |
| GET | `/api/leaderboard` · `/api/stats` | 榜单（未配置时降级本地） |
| GET/POST | `/api/settings` | 花名、榜单地址、令牌、测试目录、文件大小 |

榜单服务（`/api/v1/*`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 服务与数据概况 |
| POST | `/submit` | 校验 → 重算 → 去重 → 返回名次/百分位 |
| GET | `/leaderboard?dim&arch&suite&limit&offset&score` | 榜单 + 我的名次/前后一名/分布 |
| GET | `/machine/:fingerprint` | 单机历史 |
| DELETE | `/entry/:id` | 管理员删档（需 `LB_ADMIN_TOKEN`） |

## 7. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 没有 python3 | 4K 随机跳过，报告标注「该项不计分」，其余照常 |
| 文件系统不支持 O_DIRECT | 自动退化为带缓存模式，并在 `caveats` 明确标注"数值偏乐观" |
| 空间不足 | 自动缩小测试文件（最小 64MB），并说明 |
| 单个阶段异常 | 记录错误继续跑完，报告标「部分项缺失」 |
| 榜单服务不可达 | 天梯页显示连接失败 + 排查提示，本地成绩不受影响 |
| 套件版本不一致 | 服务端 409 拒绝，提示升级 |
| 重复提交 | 同指纹同版本取最高分，返回 `improved` 与 `previousBest` |

## 8. 测试

`npm test` → 38 项（`node:test`，无外部框架）：

- 评分：权重和、归一化方向、缺项归一、异常输入不产生 NaN、等级阈值、百分位。
- 校验：合法提交、伪造超大值、非法指纹/架构/版本、花名清洗、非数字指标丢弃。
- 榜单：只留最好成绩、排序/名次/百分位/前后邻位（含并列）、架构隔离、版本隔离、删除重建、持久化、分桶。
- HTTP：路由、bootstrap、静态回落、设置校验、404/删除/报告导出、本地降级。
- 内核：CPU 内核单调性、单核 vs 多核、内存量级、加密压缩量级与压缩率、真实磁盘读写与清理。

## 9. 后续（刻意没做）

1. 深度档：10 分钟烤机 + 温度曲线 + 降频检测（NAS 用户真正的关心点，但占机时间长，需单独入口）。
2. 转码/网络维度：需要 ffmpeg 与 iperf 对端，属于"环境依赖型测试"。
3. 成绩签名与人工复核：目前是"未校验"模式。
4. 榜单运营能力：举报、封禁、按机型聚合视图。
