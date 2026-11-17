// 会話の発言の操作（コピー、編集して送る、もう一度送る）と、生成中の印
//
// ACP にはエージェント側の履歴を巻き戻す方法がない。編集ともう一度送るは、新しいターンとして送る（前のやり取りは残る）
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { TranscriptItem } from "@/state/transcript";
import { Keys } from "../Keys";
import { isSendKey, sendKeys } from "@/lib/keys";
import { useStore } from "@/state/store";

const ICON_BUTTON =
  "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** 押すと文字をコピーし、少しのあいだ印を替える */
export function CopyButton({ text, label = "コピー" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={done ? "コピーしました" : label}
      title={done ? "コピーしました" : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}
      className={ICON_BUTTON}
    >
      {done ? <Check className="size-3.5 text-working" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

/** 発言の下に並べる操作。ふだんは隠し、発言にマウスを乗せるかフォーカスしたときに出す */
export function ActionRow({ align, children }: { align: "start" | "end"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {children}
    </div>
  );
}

export function UserActions({ text, busy, onEdit, onResend }: { text: string; busy: boolean; onEdit: () => void; onResend: () => void }) {
  return (
    <ActionRow align="end">
      <CopyButton text={text} />
      <button type="button" aria-label="編集して送る" title="編集して送る（新しいターンになります）" disabled={busy} onClick={onEdit} className={ICON_BUTTON}>
        <Pencil className="size-3.5" aria-hidden />
      </button>
      <button type="button" aria-label="もう一度送る" title="もう一度送る（新しいターンになります）" disabled={busy} onClick={onResend} className={ICON_BUTTON}>
        <RotateCcw className="size-3.5" aria-hidden />
      </button>
    </ActionRow>
  );
}

/** 自分の発言をその場で直して送る欄 */
export function EditBox({ initial, onSend, onCancel }: { initial: string; onSend: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const sendKey = useStore((s) => s.settings.send_key ?? "enter");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // 中身に合わせて高さを変える
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  const send = () => {
    if (text.trim()) onSend(text.trim());
  };
  return (
    <div className="flex w-full flex-col gap-1.5 rounded-[10px] border border-input bg-card p-2 focus-within:border-ring">
      <textarea
        ref={ref}
        aria-label="発言を編集"
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isSendKey(e, sendKey)) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="resize-none bg-transparent px-1 leading-relaxed outline-none"
      />
      <div className="flex items-center justify-end gap-1.5 text-xs">
        <span className="mr-auto px-1 text-muted-foreground">新しいターンとして送ります</span>
        <button type="button" onClick={onCancel} className="flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground">
          やめる
          <Keys keys={["esc"]} />
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={send}
          className="flex h-6 items-center gap-1.5 rounded-md bg-primary px-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          送る
          <Keys keys={sendKeys(sendKey)} onPrimary />
        </button>
      </div>
    </div>
  );
}

/** 生成中の印の文言: 最後に届いたものから、今なにをしているかを出す */
export function workingLabel(items: TranscriptItem[]): string {
  const last = items[items.length - 1];
  if (!last || last.kind === "user") return "考えています";
  if (last.kind === "thought") return "考えています";
  if (last.kind === "tool") return last.status === "pending" || last.status === "in_progress" ? "実行しています" : "考えています";
  if (last.kind === "agent") return "書いています";
  if (last.kind === "plan") return "計画しています";
  return "考えています";
}

export function Working({ label }: { label: string }) {
  return (
    <span role="status" className="shimmer text-xs">
      {label}
    </span>
  );
}
