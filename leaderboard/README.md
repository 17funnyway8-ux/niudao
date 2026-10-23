# 牛刀天梯服务 · 部署说明

零依赖（Node ≥ 18，实测 22），一个进程 + 一个 JSONL 文件就是全部。

## 公网发布（"大家都能看到"的那一步）

榜单要给别人看，必须有三样东西：**一个公网地址**、**HTTPS**、**7×24 在跑**。
下面三条路，按"你有多少资源"从上到下选。

### 路 A：Cloudflare Tunnel（推荐给家用 NAS，不用公网 IP、不用开端口）

```bash
# NAS 上装 cloudflared，把本地 8790 映射到你的域名
cloudflared tunnel login
cloudflared tunnel create niudao-lb
cloudflared tunnel route dns niudao-lb lb.example.com
cloudflared tunnel run --url http://127.0.0.1:8790 niudao-lb
```

- 不需要公网 IP、不需要路由器端口映射、证书由 Cloudflare 负责；
- 应用设置里填 `https://lb.example.com`；
- 想让服务开机自启：`sudo cloudflared service install`。

### 路 B：自己的域名 + 反代（有公网 IP 或已经做了 DDNS）

用仓库里的 compose 一把起（含 Caddy，自动申请证书）：

```bash
cd leaderboard
SITE_DOMAIN=lb.example.com LB_ADMIN_TOKEN='换成随机串' docker compose up -d
```

或者不用 Docker，用 systemd + 现有 nginx/Caddy，见下面"systemd"与"反代"两节。

### 路 C：租一台最小 VPS（最省心，但要花钱）

1 核 1G 的机器足够（服务是 Node 单进程 + JSONL）。
把仓库 `leaderboard/` 与 `src/shared/` 拷上去，`node leaderboard/server.js --port 8790`，前面挂 Caddy 即可。
需要接受别人提交分数时，注意在 VPS 防火墙只放 80/443。

### 无论走哪条，这三件事必须做

| 事项 | 做法 |
|---|---|
| 删除脏数据 | 启动时设 `LB_ADMIN_TOKEN`，用 `DELETE /api/v1/entry/<id>` + `Authorization: Bearer` |
| 备份 | 数据只有一个文件：`/data/submissions.jsonl`，每天 `cp` 一次到别的盘即可 |
| 监控 | 把 `GET /api/v1/health` 挂到任意 uptime 监控（Uptime Kuma 也行），或给容器加 `HEALTHCHECK`（镜像已内置） |

### 公开只读接口

`GET /api/v1/leaderboard?dim=overall&arch=x64&limit=100` 带 `Access-Control-Allow-Origin: *`，
所以论坛、静态站、别人的页面都能直接拉数据做自己的排行榜视图，不需要再写服务端。

## 最快启动

```bash
node leaderboard/server.js --port 8790
# 数据默认落在 leaderboard/data/submissions.jsonl
```

可用参数：

| 参数 / 环境变量 | 说明 |
|---|---|
| `--port` / `LB_PORT` | 监听端口，默认 8790 |
| `--data` / `LB_DATA` | 数据目录，默认 `leaderboard/data` |
| `--baselines` / `LB_BASELINES` | 基准文件，默认 `leaderboard/baselines.json` |
| `LB_ADMIN_TOKEN` | 设置后启用删除接口，未设置则删除入口关闭 |

浏览器打开 `http://<地址>:8790` 就是公开榜单页（纯静态，独立于应用也能看）。

## systemd（推荐，跑在同一台 NAS 上）

```ini
# /etc/systemd/system/niudao-lb.service
[Unit]
Description=Niudao Leaderboard
After=network.target

[Service]
Type=simple
User=niudao-lb
WorkingDirectory=/opt/niudao
ExecStart=/usr/bin/node /opt/niudao/leaderboard/server.js --port 8790 --data /var/lib/niudao-lb
Environment=LB_ADMIN_TOKEN=换成你的令牌
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now niudao-lb
```

## 反代（要公网访问时）

必须有 HTTPS，否则应用是 http 页面、提交会被浏览器拦。

```nginx
server {
  listen 443 ssl http2;
  server_name niudao.example.com;

  location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
  }
}
```

应用里填 `https://niudao.example.com` 即可。

## 备份与运维

- 数据只有一个文件：`submissions.jsonl`，`cp` 走就是全量备份。
- 删脏数据：`curl -X DELETE -H "Authorization: Bearer $LB_ADMIN_TOKEN" http://host:8790/api/v1/entry/<id>`；
  删完服务会重写文件并重建索引。
- 健康检查：`GET /api/v1/health` 返回机器数、提交数、套件版本。
- 升级注意：换套件版本（`src/shared/scoring.js` 的 `SUITE_VERSION`）时，把新的
  `baselines.json` 一起换掉；旧成绩会自动从新榜里排除，不会混排。

## 安全边界（请知悉）

- 服务端只接受**原始指标**并用本地 baselines 重算分数，挡住"直接改分数"。
- 有可信区间校验、指纹去重、每 IP 提交限流（12 次/小时）、请求体大小限制。
- **它不是防作弊系统**：决心作弊的人可以做一台真机器反复测、或用改过的客户端。需要更强保证时，
  下一步是成绩签名 + 抽样人工复核。
- 花名会做基本清洗（去标签、限 16 字），但仍建议你人工看一眼榜首。
