// Sidebar.tsx
import type { sidebar as source } from "../ja/sidebar";

export const sidebar: Record<keyof typeof source, string> = {
  label: "会话",
  newSession: "新建会话",
  search: "搜索",
  empty: "还没有会话",
  renameLabel: "会话名称",
  unread: "有未读通知",
  profiles: "配置",
  settings: "设置",
  rowTitle: "{title}（{profile}，{age}）",
};
