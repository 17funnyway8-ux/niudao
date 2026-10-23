# 横向调研：基准测试 / 硬件榜单类应用怎么做前后端

- 日期：2026-10-23
- 范围：开源项目 18 个、商业产品 6 个、我们自己的「牛刀」
- 目的：找出"前端要美观、后端要健壮"这件事上，别人已经解决的坑，以及我们差在哪
- 数据口径：GitHub star 数为 2026-10-23 通过 GitHub API 实时读取；商业项目信息来自官方文档/技术指南/方法论页

---

## 0. 一句话结论

我们选了**对的测量模型**（O_DIRECT、分项权重、服务端重算），但**工程形态还停留在"单人脚本 + 单页应用"**：
前端缺组件体系与图表能力，后端缺数据层、可观测性与并发/隔离，榜单缺样本置信与数据治理。
真正值得抄的三件事：**3DMark 的"逐轮最差/最好"稳定性判定**、**Speedtest 的"样本量不足不上榜"**、**Uptime Kuma / Beszel 的"单进程 + SQLite + 实时通道"工程骨架**。

---

## 1. 调研样本

### 开源

| 项目 | Stars | 语言 | 许可 | 定位 |
|---|---:|---|---|---|
| netdata/netdata | 81.1k | Go + React | GPL-3.0 | 秒级全栈监控、per-second 采集 |
| louislam/uptime-kuma | 92.8k | Node/Vue | MIT | 自托管监控 + 状态页（单机部署典范） |
| grafana/grafana | 77.5k | Go + TS | AGPL-3.0 | 可视化平台（仪表盘/告警） |
| prometheus/node_exporter | 13.9k | Go | Apache-2.0 | 主机指标导出（指标模型参考） |
| cockpit-project/cockpit | 15.3k | C/Python/JS | LGPL | 服务器 Web 控制台（系统管理 UI） |
| aristocratos/btop | 35.1k | C++ | Apache-2.0 | TUI 资源监视（美学参考） |
| nicolargo/glances | 33.8k | Python | LGPL | 跨平台系统监视 + Web UI |
| fastfetch-cli/fastfetch | 25.1k | C | MIT | 系统信息展示（信息层级参考） |
| sharkdp/hyperfine | 29.1k | Rust | Apache-2.0 | 命令行基准（统计方法 + 输出设计） |
| amanusk/s-tui | 5.1k | Python | GPL-2.0 | 压力测试 + 温度曲线 TUI |
| phoronix-test-suite/phoronix-test-suite | 3.2k | PHP | GPL-3.0 | 自动化基准套件 + OpenBenchmarking 平台 |
| bencherdev/bencher | 919 | Rust | 需确认 | 持续基准平台（回归检测/阈值） |
| henrygd/beszel | 26.5k | Go | MIT | 轻量服务器监控（新版设计参考） |
| AnalogJ/scrutiny | 8.4k | Go | MIT | 硬盘 SMART 监控 + 历史趋势 + 失效阈值 |
| LibreHardwareMonitor | 9.3k | C# | MPL-2.0 | 传感器读取库/桌面应用 |
| openmediavault/openmediavault | 7.0k | PHP | GPL | NAS 系统管理 UI |
| alexjustesen/speedtest-tracker | 6.0k | PHP/Laravel | MIT | 定时测速 + 历史图表 |
| tremorlabs/tremor | 3.7k | TS/React | Apache-2.0 | 仪表盘组件库（图表卡片范式） |

### 商业

| 产品 | 关键机制 | 对我们的直接价值 |
|---|---|---|
| UL 3DMark | **Frame Rate Stability = 最差轮/最好轮 ×100**，≥97% 判合格，20 轮约 10–20 分钟 | 稳定性判定方法论（我们目前只对比冷/热两次） |
| Primate Labs Geekbench | 固定基准机校准（GB6：i7-12700 单核 = 2500）+ Geekbench Browser 结果库 | 基准分怎么"有意义"；榜单要能按 CPU/OS 过滤 |
| PassMark PerformanceTest | 分项分 + **百分位** + **同型号内分布** | 我们只有全局百分位，缺"同款机器里你排第几" |
| Ookla Speedtest Global Index | **中位数 + 10/90 分位按 1:8:1 加权**；**95% 置信区间必须 ±5% 才上榜**；滚动 3 个月窗口 | 榜单公信力的核心：样本不足就不给名次 |
| Notebookcheck | **Perf. Rating 百分制** + 每个测试列**样本数上标（n3/n12）** + 范围（min–max） | 结果呈现要带"样本数与区间"，不是光秃秃一个数 |
| HWiNFO / CrystalDiskMark | 传感器日志与极简单页 UI；数值优先、装饰极少 | "专业感"来自克制的排版与一致的数字格式 |

---

## 2. 开源项目：他做对了什么 → 我们该抄什么

### 2.1 测量引擎层

**hyperfine（29.1k）**：默认就带 warmup、多次运行、统计离群检测，输出直接给 `mean ± σ` 和 `Range (min…max)`，还能导出 JSON/Markdown 做对比。
→ **给我们的教训**：我们已经有"多轮取最好"，但**没把离散度暴露给用户**。一次体检应该给出每个指标的 `n`、`min–max`、`σ`，让用户自己判断可不可信。

**s-tui（5.1k）**：把"压力 + 温度"做成同一屏：上面曲线、下面温度/频率/功耗，落盘为 CSV 供后续绘图。
→ 我们的深度档思路一致，但**曲线只存在于结果页，没有历史趋势**（跑 5 次看不出散热衰减）。

**Phoronix Test Suite + OpenBenchmarking.org（3.2k）**：测试定义为 XML + shell，**结果带 profile 版本、系统信息、编译参数、系统日志**；结果 ID 可直接当命令跑对比：`phoronix-test-suite benchmark 1203160-BY-NVTEGRA3785`。
→ **最值得抄的产品设计：结果即链接，链接即对比**。我们现在只能导出 JSON/MD，没法"把两次结果叠在一张图上"。

### 2.2 结果平台层

**bencher（919★，但产品形态最像我们要做的"平台"）**：核心卖点是**降低方差**——"CI runner 方差 >30%，bare metal <2%"，并把"阈值 + 统计检验"做成一等公民：PR 里回归超标就 fail。
→ 说明两件事：① 方差是这类产品的**核心敌人**，必须写在产品叙事里；② 结果平台的价值不在"存分"，在**判断这次比上次好还是坏**。

### 2.3 监控仪表盘层（"前端美观 + 后端健壮"的最佳样本）

**Uptime Kuma（92.8k，单机自托管的天花板）**：
- 技术栈：`Express + Socket.io + better-sqlite3 + knex + croner`，84 个依赖，Node ≥26
- 关键设计：**单进程 + SQLite + WebSocket 推送**；用 `http-graceful-shutdown` 处理退出；每种监控是独立"类型插件"；心跳数据带**保留策略**（定期清理）
- → 我们该抄：**实时通道（SSE/WS）替代 900ms 轮询**、**优雅退出**、**数据保留策略**

**Beszel（26.5k，2025 年后崛起）**：
- Go 单二进制 + PocketBase（SQLite）+ 内嵌前端；agent 通过 SSH/WebSocket 上报
- UI 上大量使用"卡片 + 迷你折线 + 阈值变色"，信息密度高但不脏
- → 我们该抄：**迷你折线（sparkline）进卡片**、**阈值变色规则统一**（现在我们的 pill 颜色规则散落在各处）

**Netdata（81.1k）**：每秒采集、per-second 图表、异常检测；前端是 React + 自研图表；核心是**采集与展示解耦**（collector / query engine / dashboard）。
→ 我们该抄：**采集与展示解耦**。目前 `http.js` 既管 API 又管运行态，越写越胖（542 行）。

**Grafana / node_exporter**：指标模型（counter/gauge/histogram）+ `/metrics` 端点 + 面板 JSON 化。
→ 我们该抄：加一个 `/metrics`（Prometheus 文本格式）和结构化日志，把"排障"从读 stdout 变成查指标。

**Cockpit（15.3k）**：不自己建数据库，直接调系统 API（DBus/systemd），**会话级权限**随登录用户走；插件化（每个功能一个包）。
→ 我们该抄：**权限随会话**。我们的应用是 `allUsers: true`，但没有任何"谁在跑测试"的概念——多人 NAS 上会互相打架。

### 2.4 NAS / 硬件感知层

**Scrutiny（8.4k）**：SMART + **历史趋势** + **失效阈值**（"real world failure thresholds"），而不是只画曲线。
→ 我们该抄：**阈值化**。温度 44°C 该不该报警？要有可配置/可解释的阈值，而不是让用户自己看曲线。

**LibreHardwareMonitor（9.3k）**：传感器抽象层做得很干净（硬件 → 传感器 → 值/单位/来源），跨平台后端（Windows/Linux/macOS）。
→ 我们的 `thermal.js` 已经是这个形状（discover → sample），但**没有"单位/来源/可信度"字段**，也没做"同一物理量的多来源择优"（我们只是取最大值）。

**OpenMediaVault（7.0k）**：PHP + 系统命令，UI 保守但**每个操作都有明确的前置条件与错误提示**。
→ 提醒我们：NAS 用户对"点了没反应"零容忍，**每个异步操作都要有进度与失败原因**（我们深度档有了，快速档的中止还不够干脆）。

---

## 3. 商业项目：机制细节（可直接对标的数字）

### 3.1 3DMark 压力测试：**最差轮 / 最好轮**

> Frame Rate Stability = `fpsLow / fpsHigh × 100`，`fpsHigh` = 表现最好那一轮的平均帧率，`fpsLow` = 最差那一轮；**≥97% 且跑完所有轮次才算通过**；Advanced 版 20 轮约 10–20 分钟，Professional 可设 2–5000 轮。

**这是本次调研对我们最重要的一条**：它比的是**同一次持续负载内部的波动**，因此天然抵销了"冷态 boost 预算"这类混淆因素。
我们现在的做法是"冷态最好 vs 热态最好"两个时间点相比 —— 20 秒烤机跑出 94%，但那可能只是 boost 回落，不是散热问题。

**结论：深度档应该改为在烤机过程中逐轮测吞吐，用「最差轮/最好轮」出稳定性，冷/热对比降级为辅助信息。**

### 3.2 Geekbench：基准分 + 结果库

- GB6 明确公布基准机（i7-12700，单核 2500）——**分数有绝对锚点**，我们的 1000 分同样锚定在 5825U，这点我们做对了；
- Browser 支持**按 CPU/OS/平台过滤**、逐负载拆分、结果永久 URL；
- 校验靠"计时器验证 + 特性探测（如 Intel BOT）"，**不通过就标 invalid**，但仍保留在库里。

→ 我们缺：结果永久链接（有 id 但没做分享页）、按硬件过滤、invalid 标记位。

### 3.3 PassMark：百分位 + 同型号分布

它同时给"你在全体里的百分位"和"你在**同型号**群体里的分布直方图"。
→ 我们只有全局百分位。NAS 用户真正想问的是"**同款 N100 里我这台算好还是差**"（散热/硬盘配置差异）。

### 3.4 Speedtest Global Index：样本不足不给名次

- 聚合用**中位数**，并用 10/90 分位按 **1:8:1** 加权（80% 权重给中位数）；
- 上榜门槛：**95% 置信区间必须落在中位数的 ±5% 内**；
- 数据用**滚动 3 个月**窗口，避免小样本抖动；
- 运营商只有份额 ≥3% 才参与排名。

→ 我们 5 台机器就敢显示"超过 60% 的机器"。**应该加两条规则**：① 样本 < 30 台不显示百分位，只显示"样本不足"；② 同一硬件指纹 30 天内只取最好一次（防刷分）。

### 3.5 Notebookcheck：每个数字都带样本数

表格列头是测试项，单元格是数值 + 上标 `n3`（样本数）+ 括号里的 `min–max`。
→ 我们的榜单只有单值。**加 `n` 与区间**，可信度立刻不同。

### 3.6 HWiNFO / CrystalDiskMark：专业感来自哪里

- 数字用等宽字体、单位统一、小数位固定（不出现 44.5000001）；
- 一屏只回答一个问题（DiskMark：这次跑多快；HWiNFO：现在多少度）；
- 颜色只用于表达状态，不做装饰。

→ 我们的数字格式已经统一（`num()`），但**没有"一屏一问"的信息纪律**：首页同时给了分数、维度、硬件、温度、深度入口。

---

## 4. 三方横向对比

评分 1–5（5 = 行业最佳实践），"差距"列是我们相对最好那一方的落差。

| 维度 | 开源代表 | 商业代表 | 牛刀现状 | 评分 | 差距与说明 |
|---|---|---|---:|---:|---|
| 视觉与组件体系 | Tremor / Beszel（卡片+迷你图+设计 token） | Notebookcheck（信息密度极高但清晰） | 手写 CSS + 字符串模板，无组件层 | **3/5** | app.js 962 行单体，空态/错误态/加载态靠各视图各自拼；无设计 token 层 |
| 图表能力 | Netdata / Grafana（缩放、十字线、图例、阈值线） | HWiNFO（实时日志图） | 手写 SVG 折线（两条曲线，无交互） | **2/5** | 无 tooltip / 缩放 / 多序列叠加 / 阈值线；uPlot 一个文件就能补上 |
| 信息架构与路由 | Cockpit / Grafana（深链、面包屑） | Geekbench Browser（结果永久 URL） | 无 URL 路由，刷新回首页 | **2/5** | 不能分享"某个结果页"或"某个维度榜" |
| 主题 / 国际化 / 可达性 | Grafana / Uptime Kuma（明暗、i18n、a11y） | Geekbench（多语言） | 只有暗色；中文硬编码；仅 2 个 aria 属性 | **1/5** | fnOS 桌面有明暗主题，我们没跟随 |
| 测量科学性 | hyperfine（σ、离群、warmup）/ PTS（profile 版本） | **3DMark（逐轮判定）/ Geekbench（基准锚点）/ Speedtest（置信阈值）** | 多轮取最好 + 冷/热对比 + 版本门禁 | **3/5** | 稳定性判定模型需改为逐轮；缺样本量与置信展示 |
| 可复现与对比 | OpenBenchmarking（结果 ID 即命令） | Geekbench（对比页） | 导出 JSON/MD，无对比视图 | **2/5** | 没有"两次结果叠图对比" |
| API 设计 | Grafana（版本化、OpenAPI） | Speedtest（公开方法论 + 数据口径） | REST 13 端点，无版本前缀、无 OpenAPI | **3/5** | 接口稳定但没有契约文档 |
| 数据层 | Uptime Kuma（SQLite+knex+保留策略）/ Beszel（PocketBase） | PassMark（百万级 baseline） | JSONL 全量读，每个请求 `readFileSync` | **2/5** | 1 万条成绩后会明显变慢；无索引、无保留策略 |
| 并发与隔离 | Netdata（采集/查询解耦）、Cockpit（会话权限） | 3DMark（单实例运行、独占提示） | 全局单状态机，无用户维度，无队列 | **2/5** | 多人同时点"开始体检"只会得到 409；没有"谁在跑" |
| 可观测性 | Netdata/Grafana（指标+日志+告警） | — | 只有 stdout 日志，无 `/metrics`、无结构化日志 | **2/5** | 出问题只能看 app.log |
| 滥用防护 | Uptime Kuma（登录/2FA/限流） | Speedtest（样本资格 + 置信区间） | 榜单侧有 IP 限流；应用侧 0 限流 | **3/5** | 应用 API 无任何速率限制 |
| 数据治理 | Grafana（组织/权限） | Speedtest（只统计"精度达标"的样本） | 有管理员删除，无举报/封禁/隐私说明 | **2/5** | 指纹能不能重置？用户没有控制权 |
| 部署与升级 | Uptime Kuma（一键 Docker + 内置迁移） | — | fnOS 包 + 自托管 Node，无迁移器 | **3/5** | 数据格式有 version 字段，但没有迁移逻辑 |
| 测试策略 | hyperfine（自测）/ PTS（回归套件） | — | 50 项单测，含真实磁盘/烤机 | **4/5** | 这块我们接近头部水平，缺 e2e/前端测试 |
| 供应链与体积 | — | — | **零 npm 依赖**，包 69 KB | **5/5** | 少见的优势，应作为卖点保留 |

**总评**：测量与测试（3.5/5）明显强于工程形态（2.2/5）。短板集中在"产品化"：可视化、数据层、可观测性、多人场景。

---

## 5. 差距清单（按优先级，每条给出"改成什么样"）

### P0 —— 影响可信度或会随时间劣化

1. **稳定性判定改为"逐轮最差/最好"（抄 3DMark）**
   烤机期间每 15–30 秒跑一次固定 2 秒的多核小测，得到 `frames[]`；`stability = min/max ×100`，≥97 合格。
   冷/热两次对比降级为"加速预算回落"的辅助指标。产出：`stabilityPct` + `rounds[]` + 逐轮曲线。
2. **榜单加样本门槛与置信规则（抄 Speedtest）**
   样本 < 30 台：不显示百分位，只显示"样本不足，当前 N 台"；同指纹 30 天内只取最好一次；展示"该名次基于 N 台中位数，CI ±x%"。
3. **应用侧数据层换 SQLite（抄 Uptime Kuma/Beszel）**
   `node:sqlite`（Node 22.5+ 内置）建 `results(id, ts, kind, composite, fingerprint)` + `results_json`；`getResult` 走主键，列表走索引 + 游标分页；保留策略（默认保留 200 条/滚动 12 个月）。
4. **补可观测性与优雅退出**
   `/api/metrics`（Prometheus 文本）、结构化日志（JSON lines）、`uncaughtException/unhandledRejection` 兜底、SIGTERM 时取消运行中的测试并写一条 `interrupted` 记录。

### P1 —— 影响体验与"看起来专业"

5. **前端组件化**：抽出 10 个原子组件（Card/Stat/Bar/Sparkline/Pill/Button/Toast/Empty/Table/Tabs），把 962 行的 `app.js` 拆成 `views/*.js` + `components/*.js`；统一空态/错误态/加载骨架。
6. **图表升级**：引入单文件图表库（uPlot 或自绘 + 交互层），支持 tooltip、十字线、阈值线、多序列叠加（温度+频率双轴）。
7. **URL 路由 + 结果链接**：`#/result/:id`、`#/board/storage`，刷新与分享都能落到同一屏（对齐 Geekbench/PTS 的"结果即链接"）。
8. **结果对比视图**：选两次结果 → 叠图 + 差值表（对齐 OpenBenchmarking 的核心场景）。
9. **主题与 i18n**：跟随 `prefers-color-scheme` 与 fnOS 主题；文案抽 `i18n/zh-CN.js` + `en-US.js`；补键盘可达性（`aria-*`、焦点环、表格 caption）。
10. **每个数字带样本量**：指标表展示 `n` 与 `min–max`（对齐 Notebookcheck），稳定性展示逐轮分布。

### P2 —— 增强与长线

11. **同型号内排名**（PassMark）：按 `cpu_model + mem_gb 档位` 聚合，"同款里你排 3/41"。
12. **阈值与告警**（Scrutiny）：温度/降频阈值可配，超阈值时报告里给"建议动作"而不只是数字。
13. **多人场景**：识别网关带来的 `X-Trim-Userid`，记录"谁跑的"，允许管理员限制"同时只允许一个体检"。
14. **数据治理**：用户可重置指纹、可删除自己的榜单记录；管理员侧加举报与封禁。
15. **公开 API 文档 + OpenAPI schema**：让第三方（论坛、脚本）能直接拉榜。

---

## 6. 建议路线（三轮）

| 轮次 | 主题 | 交付 |
|---|---|---|
| 第 1 轮 | **可信度** | P0-1 逐轮稳定性判定、P0-2 样本门槛、P0-3 SQLite 数据层 |
| 第 2 轮 | **专业观感** | P1-5 组件化、P1-6 图表、P1-7 路由/深链、P1-10 样本量展示 |
| 第 3 轮 | **平台化** | P1-8 对比视图、P2-11 同型号榜、P0-4 可观测性、P2-15 公开 API |

---

## 8. 落地情况（2026-10-23 当日完成）

| 编号 | 结论 | 落地 |
|---|---|---|
| P0-1 | 逐轮稳定性（3DMark） | `deep.js` 逐轮采样 + 预热窗；`stability.js` `roundsToStability`；报告出逐轮柱图 |
| P0-2 | 样本门槛与置信（Speedtest） | `leaderboard/store.js` `MIN_SAMPLES=30` + 中位数/95% CI；提交 12h 防刷 |
| P0-3 | 数据层（Kuma/Beszel） | `store.js` SQLite 主后端 + JSONL 兜底 + 迁移 + 游标分页 + 保留策略 |
| P0-4 | 可观测性（Netdata/Grafana） | `/api/metrics`、`log.js` JSON 日志、异常兜底、SIGTERM 优雅退出 |
| P1-6 | 图表交互（Grafana） | `web/js/chart.js` 十字线 + tooltip + 阈值线 |
| P1-7 | 深链（Geekbench/PTS） | hash 路由，`#/result/<id>` 可分享可刷新 |
| P1-9 | 主题（Grafana/Kuma） | 跟随系统 + 手动切换 + 亮色变量表 |
| P1-10 | 样本量与测法（Notebookcheck） | 指标表新增「测法」列；榜单显示 n / 中位数 / CI / 缺口 |

未做（已记入 spec 第 10.6 节）：i18n、完整 a11y、对比视图、同型号榜、阈值告警、公开 API。

## 7. 来源

- GitHub API：`api.github.com/repos/*`（2026-10-23 实时读取 star/语言/许可/最近推送）
- Uptime Kuma `package.json`（技术栈与依赖数）
- Phoronix Test Suite 官方文档 `documentation/phoronix-test-suite.md`（测试/套件 XML、OpenBenchmarking 集成、结果对比命令）
- Bencher README（方差叙事：CI >30% vs bare metal <2%）
- UL 3DMark 技术指南 PDF + UL 官方公告（Frame Rate Stability 公式、97% 判定、20 轮/2–5000 轮）
- Ookla Speedtest Global Index About/Methodology（中位数、1:8:1 加权、±5% 置信阈值、滚动季度、≥3% 份额）
- Notebookcheck Mobile Processors / Graphics Cards Benchmark List（Perf. Rating、样本数上标、min–max）
- Primate Labs 支持文档（valid/invalid 标签、计时器校验）与 Geekbench Browser 功能说明
