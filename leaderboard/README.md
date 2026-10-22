# 牛刀天梯服务 · 部署说明

零依赖（Node ≥ 18，实测 22），一个进程 + 一个 JSONL 文件就是全部。

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
