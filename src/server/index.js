#!/usr/bin/env node
/** 牛刀服务入口：默认监听端口（开发），安装后由 cmd/main 通过 --socket 挂到统一网关。 */
import { shutdown, start } from "./http.js";
import { CLIENT_VERSION, SUITE_VERSION } from "../shared/scoring.js";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const socketPath = process.env.NIUDAO_SOCKET || arg("--socket", "");
const port = Number(process.env.NIUDAO_PORT || arg("--port", "7788"));

const { server } = await start({ port: socketPath ? 0 : port, socketPath });

// keep-alive 不要挂太久，避免浏览器连接把优雅关闭拖死
server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;

if (socketPath) {
  console.log(`[niudao] v${CLIENT_VERSION} suite v${SUITE_VERSION} listening on unix socket ${socketPath}`);
} else {
  console.log(`[niudao] v${CLIENT_VERSION} suite v${SUITE_VERSION} listening on http://0.0.0.0:${port}`);
}

let closing = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    // 硬兜底：不管测试收没收完、连接有没有排空，10 秒后必须走人
    const hardExit = setTimeout(() => process.exit(0), 10000);
    try {
      await shutdown({ timeoutMs: 8000 });
    } catch {
      /* 忽略 */
    }
    server.close(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
    // 关掉所有 keep-alive 连接，否则 close() 会一直等
    server.closeAllConnections?.();
  });
}
