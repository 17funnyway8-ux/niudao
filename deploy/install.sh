#!/bin/bash
# 牛刀天梯服务 —— PVE 一键部署
#
# 做什么：装 Node 22（官方二进制，不动系统包）→ 解压榜单代码 → 配 systemd 守护
# 不做什么：不碰现有虚拟机、不装 Docker、不开公网端口（只监听 127.0.0.1）
# 怎么删：systemctl disable --now niudao-lb && rm -rf /opt/niudao
set -e

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$SELF_DIR/payload"
DIR=/opt/niudao
NODE_VER=v22.14.0

echo "=============================================="
echo " 牛刀天梯服务部署"
echo "=============================================="

# ---------- 0. 前置检查 ----------
if [ ! -d "$PAYLOAD/leaderboard" ]; then
  echo "❌ 安装包不完整：找不到 $PAYLOAD/leaderboard"
  echo "   请把整个压缩包解压后再运行本脚本"
  exit 1
fi
echo "✅ 安装包完整"
echo "   内存: $(free -g | awk 'NR==2{print $7" GB 可用"}')"
echo "   磁盘: $(df -h /opt 2>/dev/null | awk 'NR==2{print $4" 可用"}')"

# ---------- 1. Node 22 ----------
mkdir -p "$DIR/lb" "$DIR/data"
cd "$DIR"
if [ -x "$DIR/node/bin/node" ] && "$DIR/node/bin/node" -v 2>/dev/null | grep -q "v22"; then
  echo "✅ Node 已就绪: $("$DIR/node/bin/node" -v)"
else
  echo "→ 下载 Node $NODE_VER（约 25MB，国内镜像优先）..."
  rm -f node.tar.xz
  ok=0
  for u in "https://npmmirror.com/mirrors/node/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" \
           "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"; do
    echo "   尝试: $(echo "$u" | cut -d/ -f3)"
    if curl -fsSL --connect-timeout 10 -m 300 "$u" -o node.tar.xz; then ok=1; break; fi
  done
  [ "$ok" = "1" ] || { echo "❌ Node 下载失败，检查这台机器能不能上网"; exit 1; }
  tar xJf node.tar.xz
  rm -rf node
  mv "node-$NODE_VER-linux-x64" node
  rm -f node.tar.xz
  echo "✅ Node: $("$DIR/node/bin/node" -v)"
fi

# ---------- 2. 榜单代码 ----------
# 只替换代码目录，数据目录 $DIR/data 完全不动 —— 重装/升级不丢成绩
echo "→ 部署榜单代码（数据保留在 $DIR/data）..."
rm -rf "$DIR/lb"
mkdir -p "$DIR/lb"
cp -a "$PAYLOAD/." "$DIR/lb/"
echo "✅ 代码就位: $(ls "$DIR/lb/leaderboard" | tr '\n' ' ')"

# ---------- 3. 管理令牌 ----------
# 重复部署时复用已有令牌：换掉会让之前的删除脚本/运维记录失效
if [ -s "$DIR/admin_token.txt" ]; then
  ADMIN_TOKEN=$(cat "$DIR/admin_token.txt")
  echo "✅ 沿用已有管理令牌"
else
  ADMIN_TOKEN=$("$DIR/node/bin/node" -e "console.log(require('crypto').randomBytes(18).toString('base64url'))")
  echo "$ADMIN_TOKEN" > "$DIR/admin_token.txt"
  chmod 600 "$DIR/admin_token.txt"
  echo "✅ 已生成新的管理令牌"
fi

# ---------- 4. systemd ----------
echo "→ 配置 systemd 服务..."
cat > /etc/systemd/system/niudao-lb.service <<UNIT
[Unit]
Description=Niudao Leaderboard (internal, behind Cloudflare Tunnel)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR/lb
Environment=LB_PORT=8790
Environment=LB_DATA=$DIR/data
Environment=LB_ADMIN_TOKEN=$ADMIN_TOKEN
ExecStart=$DIR/node/bin/node leaderboard/server.js
Restart=always
RestartSec=3
MemoryMax=512M
CPUQuota=100%
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now niudao-lb >/dev/null 2>&1
sleep 3

# ---------- 5. 验证 ----------
echo
echo "=============================================="
echo " 验证结果"
echo "=============================================="
if systemctl is-active --quiet niudao-lb; then
  echo "✅ 服务运行中"
else
  echo "❌ 服务没起来，最后 20 行日志："
  journalctl -u niudao-lb -n 20 --no-pager
  exit 1
fi

echo "→ 监听地址（应该只有 127.0.0.1，公网碰不到）："
ss -lntp | grep 8790 || echo "   ⚠️ 没看到 8790 端口"

echo "→ 健康检查："
if curl -fsS -m 5 http://127.0.0.1:8790/api/v1/health; then
  echo
else
  echo "   ❌ 健康检查失败"
  journalctl -u niudao-lb -n 20 --no-pager
  exit 1
fi

echo
echo "=============================================="
echo " 部署完成"
echo "=============================================="
echo "服务名:   niudao-lb"
echo "代码目录: $DIR/lb"
echo "数据目录: $DIR/data"
echo
echo "常用命令："
echo "  看状态:   systemctl status niudao-lb"
echo "  看日志:   journalctl -u niudao-lb -f"
echo "  重启:     systemctl restart niudao-lb"
echo "  完全删除: systemctl disable --now niudao-lb && rm -rf $DIR"
echo
echo "管理令牌（删脏数据用，已存到 $DIR/admin_token.txt）:"
echo "  $ADMIN_TOKEN"
