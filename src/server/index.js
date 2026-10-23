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
    await shutdown({ timeoutMs: 8000 });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
