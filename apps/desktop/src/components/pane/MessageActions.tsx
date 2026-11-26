// Message actions in the transcript (copy, edit and send, send again) and the generating indicator
//
// ACP has no way to rewind the agent's history. Edit and send-again go out as new turns (earlier exchanges stay)
import { ArrowLeftToLine, Check, Copy, Pencil, RotateCcw, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { TranscriptItem } from "@/state/transcript";
import { Keys } from "../Keys";
import { isSendKey, sendKeys } from "@/lib/keys";
import { useStore } from "@/state/store";
import { useT } from "@/i18n";

const ICON_BUTTON =
  "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/** Copies the text on click and swaps the icon briefly */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={done ? t("message.copied") : (label ?? t("message.copy"))}
      title={done ? t("message.copied") : (label ?? t("message.copy"))}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}
      className={ICON_BUTTON}
    >
      {done ? <Check className="size-3.5 text-working" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

/** Put this text into another input (a side chat's answer into the main session's input) */
export function QuoteButton({ text, label, onQuote }: { text: string; label: string; onQuote: (text: string) => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={() => onQuote(text)} className={ICON_BUTTON}>
      <ArrowLeftToLine className="size-3.5" aria-hidden />
    </button>
  );
}

/** Send this text to another session as its next instruction (a review finding back to the reviewed session) */
export function SendBackButton({ text, label, onSend }: { text: string; label: string; onSend: (text: string) => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={() => onSend(text)} className={ICON_BUTTON}>
      <SendHorizontal className="size-3.5" aria-hidden />
    </button>
  );
}

/** Actions under a message. Hidden by default; shown on hover or focus */
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
  const t = useT();
  return (
    <ActionRow align="end">
      <CopyButton text={text} />
      <button type="button" aria-label={t("message.editAndSend")} title={t("message.editAndSendHint")} disabled={busy} onClick={onEdit} className={ICON_BUTTON}>
        <Pencil className="size-3.5" aria-hidden />
      </button>
      <button type="button" aria-label={t("message.resend")} title={t("message.resendHint")} disabled={busy} onClick={onResend} className={ICON_BUTTON}>
        <RotateCcw className="size-3.5" aria-hidden />
      </button>
    </ActionRow>
  );
}

/** Inline editor for fixing and resending the user's own message */
export function EditBox({ initial, onSend, onCancel }: { initial: string; onSend: (text: string) => void; onCancel: () => void }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const sendKey = useStore((s) => s.settings.send_key ?? "enter");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // Resize to fit the content
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
        aria-label={t("message.editLabel")}
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
        <span className="mr-auto px-1 text-muted-foreground">{t("message.sendsAsNewTurn")}</span>
        <button
          type="button"
          onClick={onCancel}
          className="flex h-6 items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("message.cancel")}
          <Keys keys={["esc"]} />
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={send}
          className="flex h-6 items-center gap-1.5 rounded-md bg-primary px-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {t("message.send")}
          <Keys keys={sendKeys(sendKey)} onPrimary />
        </button>
      </div>
    </div>
  );
}

/** Label for the generating indicator: what's happening now, based on the last thing received */
export function workingLabel(items: TranscriptItem[]) {
  // If a tool is running in this turn, show "running" whatever arrived last
  for (let i = items.length - 1; i >= 0 && items[i].kind !== "user"; i--) {
    const it = items[i];
    if (it.kind === "tool" && (it.status === "pending" || it.status === "in_progress")) return "message.running";
  }
  const last = items[items.length - 1];
  if (!last || last.kind === "user") return "message.thinking";
  if (last.kind === "thought") return "message.thinking";
  if (last.kind === "tool") return last.status === "pending" || last.status === "in_progress" ? "message.running" : "message.thinking";
  if (last.kind === "agent") return "message.writing";
  if (last.kind === "plan") return "message.planning";
  return "message.thinking";
}

export function Working({ label }: { label: string }) {
  return (
    <span role="status" className="shimmer text-xs">
      {label}
    </span>
  );
}
