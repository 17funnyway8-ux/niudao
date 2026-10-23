# 牛刀天梯服务（公网部署用镜像）
# 构建上下文是仓库根目录：docker build -f leaderboard/Dockerfile .
FROM node:22-alpine

WORKDIR /app

# 服务端只依赖 Node 标准库 + 共享的评分/校验模块
COPY leaderboard ./leaderboard
COPY src/shared ./src/shared

ENV LB_PORT=8790 \
    LB_DATA=/data \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "leaderboard/server.js"]
