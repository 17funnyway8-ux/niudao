/**
 * 反馈脱敏规则（服务端版本）。
 *
 * 与 src/server/feedback.js 里的 redact() 保持一致 —— 那边在客户端侧先脱敏给用户看，
 * 这边是**落库前的最后一道**：不信任客户端，旧版本或手工 POST 的原始日志也在这里过滤。
 * 两边算法必须同步，所以有 test/feedback.test.js 同时验证两边。
 */

/** 脱敏：把可能泄露隐私/敏感信息的内容替换掉。私网优先，再做公网兜底。 */
export function redact(text) {
  let out = String(text ?? "");

  // 1) 私网 / 本机 IP（含端口）。10.x 与 127.x 的第三段可以是 0，别用固定两段的宽松写法。
  out = out.replace(
    /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d{2,5})?(?![\d.])/g,
    "[内网IP]",
  );

  // 2) IPv6
  out = out.replace(/\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/gi, "[IPv6]");

  // 3) Bearer 先处理：否则 "Authorization: Bearer xxx" 会被下面的规则拆成两段，token 漏出去
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[已隐藏]");
  // 4) 令牌 / 密钥
  out = out.replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, "$1[已隐藏]");

  // 5) 用户目录：保留卷根（能定位是哪块盘），抹掉后面的目录结构
  out = out.replace(/(\/(?:vol\d+|volume\d+|mnt|media|home)\/[^/\s"']+)(\/[^\s"',}]*)?/g, "$1/[已隐藏]");

  // 6) 主机名（JSON 与非 JSON 两种形态）
  out = out.replace(/("hostname"\s*:\s*")[^"]*(")/g, "$1[已隐藏]$2");
  out = out.replace(/(^|\n)\s*hostname\s*[:=]\s*\S+/gi, "$1hostname: [已隐藏]");
  out = out.replace(/\bhostname\s*[:=]\s*\S+/gi, "hostname: [已隐藏]");

  // 7) 公网 IPv4 兜底：私网已被替换，剩下四段数字且不像版本号（三段）的都抹掉
  out = out.replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, "[公网IP]");

  return out;
}

