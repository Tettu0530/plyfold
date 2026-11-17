// SearchCard.tsx（⌘K の検索）
import type { search as source } from "../ja/search";

export const search: Record<keyof typeof source, string> = {
  newSession: "新建会话",
  switchMode: "切换 mode",
  stopTurn: "停止运行中的轮次",
  settings: "设置",
  profiles: "配置",
  recent: "最近的会话",
  commands: "命令",
  close: "关闭搜索",
  label: "搜索",
  placeholder: "搜索会话或命令",
  noResults: "未找到结果",
  navigate: "移动",
  open: "打开",
};
