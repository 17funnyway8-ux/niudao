/**
 * 内置的公共榜单地址。
 *
 * 说明：这是随包发布的默认值，用户可在设置里覆盖或清空。
 * 换地址只需改这一处并重新打包；前端会用 /api/leaderboard 的健康检查显示在线状态，
 * 连不上时自动退化为本地成绩单，不会影响体检功能。
 */
export const OFFICIAL_LEADERBOARD = "https://8790-agqvosnubdwfqzie6uwxtp26fm.instabox.tech";

/** 是否指向官方榜（用于界面上标一下来源） */
export function isOfficial(url) {
  const norm = (s) => String(s || "").trim().replace(/\/+$/, "").toLowerCase();
  return norm(url) === norm(OFFICIAL_LEADERBOARD);
}
