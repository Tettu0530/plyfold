// The side chat beside a session (components/pane/SideChat.tsx)
export const side = {
  open: "サイドチャット",
  title: "サイドチャット",
  forkedNow: "分岐したばかり",
  forkedAgo: "{n} 分前に分岐",
  refresh: "本筋の今の会話から取り直す（ここでの会話は消えます）",
  close: "閉じる（ここでの会話は消えます）",
  starting: "本筋の会話を写しています",
  hint: "本筋の会話を受け継いだ分岐です。ここでの質問と答えは本筋に入りません。ファイルの編集とコマンドは断ります",
  quote: "本筋の入力欄へ",
  placeholder: "本筋について質問",
} satisfies Record<string, string>;
