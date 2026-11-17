// エージェントの発言を Markdown として描く（react-markdown + remark-gfm: 表、チェックリスト、取り消し線、自動リンク）
//
// - 見た目は shadcn のトークンだけで作る（文字の大きさは 12 / 13 / 14 / 16 px の 4 段階）
// - リンクは既定のブラウザで開く（WebView の中で開くとアプリの画面が替わる）
// - 外の画像は読み込まない（会話の中から勝手に通信しない）。代わりに代替テキストをリンクとして出す
// - HTML は描かない（react-markdown の既定。エージェントの出力に混ざった HTML を実行しない）
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { api, inTauri } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CopyButton } from "./MessageActions";

function openLink(href: string | undefined) {
  if (!href) return;
  if (inTauri) void api.openUrl(href).catch(() => {});
  else window.open(href, "_blank", "noopener");
}

/** コードの塊: 言語の名前とコピーのボタンを上に出す */
function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  return (
    <div className="my-2 overflow-hidden rounded-[10px] border bg-card">
      <div className="flex h-7 items-center border-b pr-1 pl-3">
        <span className="grow font-mono text-xs text-muted-foreground">{lang ?? "text"}</span>
        <CopyButton text={code} label="コードをコピー" />
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2 font-mono text-xs leading-5 select-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  p: ({ children }) => <p className="my-2 leading-[1.7] first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h6>,
  h6: ({ children }) => <h6 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h6>,
  ul: ({ children, className }) => (
    <ul className={cn("my-2 flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground", className?.includes("contains-task-list") && "list-none pl-1")}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 flex list-decimal flex-col gap-1 pl-5 marker:font-mono marker:text-muted-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-[1.7] [&>p]:my-0">{children}</li>,
  input: ({ checked }) => <input type="checkbox" checked={!!checked} disabled readOnly className="mr-1.5 translate-y-px accent-foreground" />,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-4 border-border" />,
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        openLink(href);
      }}
      className="text-foreground underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground"
    >
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a
      href={typeof src === "string" ? src : undefined}
      onClick={(e) => {
        e.preventDefault();
        openLink(typeof src === "string" ? src : undefined);
      }}
      className="text-muted-foreground underline underline-offset-2"
    >
      画像: {alt || (typeof src === "string" ? src : "")}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-[10px] border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-card">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border-b px-3 py-1.5 text-left font-medium text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border-t px-3 py-1.5 align-top first-of-type:border-l-0">
      {children}
    </td>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1] ?? null;
    // 塊のコード（``` で囲んだもの）は言語の class が付くか、改行を含む
    if (lang || text.includes("\n")) return <CodeBlock lang={lang} code={text.replace(/\n$/, "")} />;
    return <code className="rounded-[4px] bg-muted px-1 py-px font-mono text-[12px]">{children}</code>;
  },
};

/** Markdown の本文。streaming のあいだは、最後の要素の後ろに書いている印を出す */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={cn("min-w-0 break-words select-text", streaming && "md-streaming")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
