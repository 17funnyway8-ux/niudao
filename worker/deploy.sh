#!/usr/bin/env bash
# 一条命令部署牛刀天梯到 Cloudflare Workers + D1。
#
#   CLOUDFLARE_API_TOKEN=xxx ./worker/deploy.sh
#   CLOUDFLARE_API_TOKEN=xxx ADMIN_TOKEN=随便一串 ./worker/deploy.sh
#
# 需要 token 具备：Workers Scripts:Edit、D1:Edit、Account Settings:Read
set -euo pipefail

cd "$(dirname "$0")"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "缺少 CLOUDFLARE_API_TOKEN。到 https://dash.cloudflare.com/profile/api-tokens 建一个："
  echo "  Permissions: Account → Workers Scripts:Edit, Account → D1:Edit, Account → Account Settings:Read"
  exit 1
fi

WRANGLER="npx --yes wrangler@4"
DB_NAME="niudao-lb"

echo "==> 1/5 确认 D1 数据库"
DB_ID=$($WRANGLER d1 list --json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try {
      const list = JSON.parse(s);
      const hit = list.find(x => x.name === process.env.DB_NAME);
      process.stdout.write(hit ? hit.uuid : "");
    } catch { process.stdout.write(""); }
  });' 2>/dev/null || true)

if [[ -z "${DB_ID}" ]]; then
  echo "    没找到，创建：$DB_NAME"
  DB_ID=$($WRANGLER d1 create "$DB_NAME" 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  [[ -n "$DB_ID" ]] || { echo "创建 D1 失败"; exit 1; }
fi
echo "    database_id = $DB_ID"

echo "==> 2/5 写入 wrangler.toml"
node -e '
  const fs = require("fs");
  const p = "wrangler.toml";
  const id = process.argv[1];
  let s = fs.readFileSync(p, "utf8");
  s = s.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
  fs.writeFileSync(p, s);
' "$DB_ID"

echo "==> 3/5 建表"
$WRANGLER d1 execute "$DB_NAME" --remote --yes --file=schema.sql > /dev/null
echo "    schema 已应用"

echo "==> 4/5 管理员令牌"
if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  printf '%s' "$ADMIN_TOKEN" | $WRANGLER secret put ADMIN_TOKEN --name "${WORKER_NAME:-niudao-lb}" > /dev/null
  echo "    ADMIN_TOKEN 已设置（用于删除脏数据）"
else
  echo "    跳过（未提供 ADMIN_TOKEN；之后可用 wrangler secret put ADMIN_TOKEN 补上）"
fi

echo "==> 5/5 部署"
$WRANGLER deploy 2>&1 | tee /tmp/niudao-deploy.log | grep -E "Deployed|https://|Version ID" || true

URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' /tmp/niudao-deploy.log | head -1 || true)
echo
if [[ -n "$URL" ]]; then
  echo "上线地址：$URL"
  echo "验证：curl $URL/api/v1/health"
  echo
  echo "下一步：把地址写进 src/shared/endpoints.js 的 OFFICIAL_LEADERBOARD，然后 node build.mjs --pack"
else
  echo "部署完成但没解析到 URL，请看上面的输出。"
fi
