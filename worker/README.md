# 牛刀天梯 · Cloudflare Workers 版

和自托管版（`leaderboard/server.js`）**同一套 HTTP 契约**，客户端只改一个地址就能切过来。
好处：没有服务器要养、不会休眠、免费额度足够（Workers 10 万请求/天，D1 5 GB / 每天 500 万行读）。

## 部署（一次性，约 2 分钟）

### 方式一：API Token（推荐，适合远程/容器/CI）

```bash
# 1. 建 token：https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom
#    Permissions 三行：
#      Account · Workers Scripts · Edit
#      Account · D1 · Edit
#      Account · Account Settings · Read
# 2. 一条命令部署（会自动建 D1、建表、部署）
CLOUDFLARE_API_TOKEN=xxx ADMIN_TOKEN=随便一串 ./worker/deploy.sh
```

### 方式二：OAuth 登录（只能在本机浏览器可用的环境）

注意：Cloudflare 的 OAuth 回调**写死为 `http://localhost:8976/oauth/callback`**，
所以在服务器/容器里跑 `wrangler login` 需要你本机做端口转发：

```bash
ssh -L 8976:127.0.0.1:8976 <这台机器>     # 另开一个终端保持连接
npx wrangler login                        # 把它打印的链接在本机浏览器打开
```

（`--device` 设备码模式当前被 Cloudflare 拒绝，返回 403，不用试。）

### 方式三：手动分步

```bash
cd worker
npx wrangler login                      # 浏览器授权一次

npx wrangler d1 create niudao-lb        # 输出 database_id，复制到 wrangler.toml
#   [[d1_databases]]
#   binding = "DB"
#   database_name = "niudao-lb"
#   database_id = "<粘贴这里>"

npx wrangler d1 execute niudao-lb --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN     # 管理员删除用的令牌，随便一串随机字符

npx wrangler deploy
```

部署完会打印地址，形如：

```
https://niudao-lb.<你的子域>.workers.dev
```

**已上线的实例**：https://lb.1133891.xyz（自定义域名，绑在 Worker `niudao-lb` 上）。

> `*.workers.dev` 在国内网络会被 DNS 污染（实测解析到 Dropbox 的 IP、TLS 超时），
> 所以正式地址必须走自定义域名。绑定方式：
>
> ```bash
> curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<账号ID>/workers/domains" \
>   -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
>   -d '{"zone_id":"<zone ID>","hostname":"lb.1133891.xyz","service":"niudao-lb","environment":"production"}'
> ```
>
> 绑完约 10–30 秒生效（自动签证书），可用 `curl https://lb.1133891.xyz/api/v1/health` 验证。

把这个地址填进应用（或改 `src/shared/endpoints.js` 的常量后重新打包），就切换过去了。
想用自己的域名：Cloudflare 控制台 → Workers → 该 Worker → Settings → Domains & Routes → Add custom domain，
它会自动签发证书（域名需要托管在同一个 CF 账号下）。

## 本地验证（不需要部署）

```bash
node worker/scripts/sync-assets.mjs        # 把榜单页与基准编译进 assets.js
npm test                                    # 含 worker 的 11 项集成测试（node:sqlite 模拟 D1）
npx wrangler dev --local                    # 起本地实例，D1 用本地 sqlite
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 服务与数据概况 |
| POST | `/api/v1/submit` | 收原始指标 → 服务端重算分数 → 写库（同机器只留最好） |
| GET | `/api/v1/leaderboard?dim=&arch=&limit=&offset=&score=` | 榜单 + 我的名次/前后一名/分布 |
| GET | `/api/v1/stats` | 机器数 |
| GET | `/api/v1/machine/:fingerprint` | 单机历史 |
| DELETE | `/api/v1/entry/:id` | 需要 `Authorization: Bearer $ADMIN_TOKEN` |
| GET | `/` | 公开榜单页（与自托管版共用同一份 HTML） |

响应字段与 `leaderboard/server.js` 完全一致（含 `stats.gated`、`stats.ci`、`me.above/below`）。

## 防刷与统计口径

- 只接受原始指标，分数一律重算，客户端改分无效；
- 同一台机器（硬件指纹）12 小时内只写一次，除非综合分提升 >3%；
  没写进去时返回 `{ ok: true, kept: true, message }`（不是错误，前端提示"保留原成绩"）；
- 样本 < 30 台不给百分位，只给名次与中位数；
- 跨套件版本不混榜（`suite` 是查询条件）；
- 架构默认分开排（`arch`）。

## 成本与限制

| 项 | 免费额度 | 我们大概会用多少 |
|---|---|---|
| Workers 请求 | 100,000/天 | 每次提交 1 次 + 每次看榜 1 次；几百台机器的社区量级远远够 |
| D1 存储 | 5 GB | 一条记录约 1.5 KB，5 GB ≈ 300 万条 |
| D1 行读 | 500 万/天 | 一次看榜约 10 次查询，1 万次浏览 = 10 万行 |

真到超量了，最省事的做法是给看榜接口加 `Cache-Control`（榜单本身不需要秒级实时）。

## 目录

```
worker/
├── wrangler.toml        配置（D1 绑定、compatibility_date）
├── schema.sql           D1 表结构
├── scripts/sync-assets.mjs   把榜单页 + 基准编译成 assets.js
├── src/assets.js        （自动生成，勿手改）
├── src/index.js         路由与业务
├── src/store.js         D1 查询（白名单列名，全部绑定参数）
└── test/worker.test.js  11 项集成测试（node:sqlite 模拟 D1）
```
