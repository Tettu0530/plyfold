// SearchCard.tsx (⌘K search)
import type { search as source } from "../ja/search";

export const search: Record<keyof typeof source, string> = {
  newSession: "新建会话",
  switchMode: "切换模式",
  stopTurn: "停止运行中的轮次",
  settings: "设置",
  profiles: "配置文件",
  recent: "最近的会话",
  messages: "消息",
  searching: "正在搜索",
  commands: "命令",
  close: "关闭搜索",
  label: "搜索",
  placeholder: "搜索会话、消息或命令",
  noResults: "未找到结果",
  navigate: "移动",
  open: "打开",
};
