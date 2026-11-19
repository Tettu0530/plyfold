// Sidebar.tsx
import type { sidebar as source } from "../ja/sidebar";

export const sidebar: Record<keyof typeof source, string> = {
  label: "会话",
  newSession: "新建会话",
  search: "搜索",
  empty: "还没有会话",
  renameLabel: "会话名称",
  unread: "有未读通知",
  prompts: "已保存的提示词",
  profiles: "配置",
  settings: "设置",
  rowTitle: "{title}（{profile}，{age}）",
  resize: "侧边栏宽度",
  resizeHint: "拖动以调整宽度，双击恢复默认宽度。",
  conversations: "对话",
  updateAvailable: "更新到 {version}",
  updating: "正在安装 {version}",
  trash: "废纸篓",
  restore: "恢复「{title}」",
  deleteForGood: "永久删除「{title}」",
  emptyTrash: "清空废纸篓",
  trashNote: "记录 30 天后自动删除，worktree 会保留",
  groupName: "分组名称",
  renameGroup: "重命名「{name}」",
};
