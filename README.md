# 牛刀 · fnOS Benchmark

给飞牛 NAS 打分的硬件性能测试。四十秒，十项实测，一个分数，和别人的机器排进同一个天梯。

原生 fnOS 应用（`.fpk`），零 npm 依赖，零外部 CDN，断网可用（天梯需要联网）。

---

## 测什么

| 项目 | 说明 | 对应的 NAS 场景 |
|---|---|---|
| CPU 单核 | 整数混算 | 点开应用、Web 面板的响应速度 |
| CPU 多核 | 全核并发 | 多任务、Docker 容器并发 |
| AES-256-GCM | 加密吞吐 | SMB 加密传输 |
| zlib | 压缩吞吐 | 备份压缩、解压 |
| 内存带宽 | memcpy | 大文件搬运 |
| 内存随机访问延迟 | 指针追逐 | 元数据小请求、数据库 |
| 磁盘顺序读写 | O_DIRECT 大块 | 影音播放、大文件备份 |
| 磁盘 4K 随机 | O_DIRECT + QD1 | 相册缩略图、虚拟机镜像 |

另有可选的**持续负载测试**（3–20 分钟满载烤机）：逐轮采样吞吐、温度、频率，判定散热与功耗墙是否压住持续性能。

## 评分

以一台标定机（AMD Ryzen 7 5825U）为 1000 分基准，各项按基准归一化后加权：

- CPU 40%（单核 45%、多核 40%、加密 7.5%、压缩 7.5%）
- 内存 20%（带宽 55%、延迟 45%）
- 存储 40%（顺序读 17.5%、顺序写 17.5%、4K 随机读 39%、4K 随机写 26%）

分数由服务端依据原始指标重算，客户端无法伪造。

## 几处刻意的测量设计

做 benchmark 最容易犯的错是「测出来的东西不是你想测的」。这里几处判据都有物理依据，不是拍数字：

### 磁盘测试写不可压缩数据

写 `if=/dev/zero` 在开启压缩的文件系统（btrfs zstd/lz4）上会被压到几乎为零，测出来的是压缩吞吐而不是磁盘速度。内测见过 Intel N150 报 10,233 MB/s、i7-8700 + H310 主板报 13,128 MB/s —— 物理上不可能。

改为生成随机种子重复写满（btrfs 按 128KB 块独立压缩，块内高熵压不动）。

### 内存延迟的工作集按 L3 动态定

固定 32MB 的环遇到 L3 ≥ 32MB 的 CPU（AMD Strix Halo 32MB、Xeon E5-2680 v4 35MB）会整条装进缓存，测出来是缓存延迟而非内存延迟。

改为读 `/sys/devices/system/cpu/cpu0/cache/index3/size`，环取 `max(32, min(64, 2×L3))`。

### 4K 随机用延迟判断数据真假

消费者的「几十万 IOPS」是 QD32 的数字，这里测的是 **QD1**，两者差 50–100 倍。QD1 下 IOPS 完全由单次访问延迟决定：

```
IOPS = 1,000,000 ÷ 延迟(μs)
```

持久化存储的 4K 单次访问不可能快过 **10μs**（DRAM 0.1μs / Optane ~10μs / 消费级 NVMe 50–80μs / SATA SSD 100–200μs）。低于这条线只可能来自页缓存、内存盘或虚拟化内存。

所以判据是**延迟**而不是 IOPS 数值 —— 数值上真实高端盘（Optane QD1 40–60k）和虚机缓存（十几万）会重叠，延迟上不会。

### 磁盘封顶按物理上限换算

顺序读写封顶 8000 / 7000 MB/s（PCIe 4.0 单盘约 7000），4K 随机 60000 IOPS（覆盖 Optane）。算力类指标（CPU、内存带宽）不封顶 —— 机器强就是强。

### 物理机与虚拟机分开排名

虚拟机的 CPU、内存、磁盘都来自宿主机，磁盘还常被页缓存放大。判定依据来自内核（DMI 虚拟化特征、`cpuinfo` 的 hypervisor 标志位、`/sys/hypervisor/type`），判定证据在报告中公开。

## 安装

从 [Releases](https://github.com/17funnyway8-ux/niudao/releases) 下载最新的 `.fpk`，在飞牛 fnOS 应用中心手动安装。

依赖：`nodejs_v22`、`python312`（飞牛中间件，安装时自动拉取）。

## 自建天梯

榜单服务是独立可部署的（Node 单文件 + JSONL 存储）：

```bash
node leaderboard/server.js --port 8790
```

默认只监听 `127.0.0.1`。需要局域网访问时显式加 `--host 0.0.0.0`。

环境变量：

| 变量 | 用途 |
|---|---|
| `LB_PORT` | 端口，默认 8790 |
| `LB_DATA` | 数据目录，默认 `leaderboard/data` |
| `LB_ADMIN_TOKEN` | 删除脏数据的凭证；不设则删除入口关闭 |

公网暴露建议走 Cloudflare Tunnel（不需要公网 IP、不需要开端口）：

```bash
cloudflared service install <token>
```

## 开发

```bash
npm test                    # 单测（147 项）
node build.mjs --pack       # 组装并打包 .fpk
node src/server/index.js --port 7788   # 本地开发
```

目录：

```
src/server/         应用后端（Unix Socket / 端口）
src/server/bench/   各项基准实现
src/shared/         评分、schema、稳定性判定（前后端共用）
src/web/            前端（零依赖，手写 SVG 图表）
leaderboard/        自建榜单服务
worker/             云端榜单（Cloudflare Worker + D1）
package/            fnOS 应用包结构（manifest / cmd / wizard）
deploy/             自建服务的部署脚本
test/               单测
```

## 隐私

- 榜单只上传机型、核心数、内存容量与实测数值
- **不上传**文件名、目录路径、序列号或任何文档内容
- 硬件指纹由硬件参数哈希生成，不含设备标识符
- 应用内反馈会先做脱敏（去除内网 IP、路径、主机名）
- 可在设置或安装时关闭自动提交，关闭后应用完全不联网

## 许可

MIT
