// Render agent messages as Markdown (react-markdown + remark-gfm: tables, task lists, strikethrough, autolinks)
//
// - Styled with shadcn tokens only (four text sizes: 12 / 13 / 14 / 16 px)
// - Links open in the default browser (opening inside the WebView would replace the app's screen)
// - External images are not loaded (no network requests from the transcript). Their alt text is shown as a link instead
// - HTML is not rendered (react-markdown's default; HTML mixed into agent output never runs)
// - Math ($…$, $$…$$, \(…\), \[…\]) is typeset with KaTeX
import { createContext, memo, useContext, useId } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import { useT, contentLang } from "@/i18n";
import { api, inTauri } from "@/lib/api";
import { normalizeMath } from "@/lib/math";
import { cn } from "@/lib/utils";
import { CopyButton } from "./MessageActions";
import { imageSource } from "@/lib/imageSrc";
import { PreviewGroup, useFileImage } from "../ImagePreview";
import { Thumb } from "./Attachments";

/** Open a link in the default browser (inside the WebView it would replace the app) */
export function openLink(href: string | undefined) {
  if (!href) return;
  if (inTauri) void api.openUrl(href).catch(() => {});
  else window.open(href, "_blank", "noopener");
}

/** Code block: shows the language name and a copy button on top */
function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const t = useT();
  return (
    <div className="my-2 overflow-hidden rounded-[10px] border bg-card">
      <div className="flex h-7 items-center border-b pr-1 pl-3">
        <span className="grow font-mono text-xs text-muted-foreground">{lang ?? "text"}</span>
        <CopyButton text={code} label={t("transcript.copyCode")} />
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2 font-mono text-xs leading-5 select-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** The folder relative image paths in an answer start from (the session's worktree or repository) */
const ImageBase = createContext<string | undefined>(undefined);

/**
 * An image in an answer: a file on this machine (or a data URL) is shown as a thumbnail that opens large; an image on
 * the web is not fetched and stays a link, as does a file that cannot be read
 */
function AnswerImage({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const source = imageSource(src, useContext(ImageBase));
  const read = useFileImage(source?.kind === "file" ? source.path : null);
  const shown = source?.kind === "data" ? source.src : read;
  const anchor = `md-img:${useId()}`;
  if (shown) return <Thumb src={shown} name={alt || src || ""} anchor={anchor} className="size-28 object-cover" />;
  // Keeps its place while the file is read, so the answer does not jump
  if (source?.kind === "file" && shown === undefined) return <span className="block size-28 rounded-md border bg-muted" aria-hidden />;
  return <ImageLink src={src} alt={alt} />;
}

/** Show the alt text as a link (opens in the browser or the system's viewer) */
function ImageLink({ src, alt }: { src: string | undefined; alt: string | undefined }) {
  const t = useT();
  return (
    <a
      href={src}
      onClick={(e) => {
        e.preventDefault();
        openLink(src);
      }}
      className="text-muted-foreground underline underline-offset-2"
    >
      {t("transcript.image", { alt: alt || (src ?? "") })}
    </a>
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
    <ul className={cn("my-2 flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground", className?.includes("contains-task-list") && "list-none pl-1")}>
      {children}
    </ul>
  ),
  // Numbered by a counter drawn inside the column (index.css .md-ol): browser markers hang outside it, and the wide
  // mono digits stuck out past the left edge of the text
  ol: ({ children, start }) => (
    <ol start={start} style={{ counterReset: `md-ol ${(start ?? 1) - 1}` }} className="md-ol my-2 flex flex-col gap-1">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-[1.7] [&>p]:my-0">{children}</li>,
  input: ({ checked }) => <input type="checkbox" checked={!!checked} disabled readOnly className="mr-1.5 translate-y-px accent-foreground" />,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-4 border-border" />,
  div: ({ node: _node, className, ...props }) =>
    className === "md-gallery" ? <div className="my-2 flex flex-wrap gap-2" {...props} /> : <div className={className} {...props} />,
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
  img: ({ src, alt }) => <AnswerImage src={typeof src === "string" ? src : undefined} alt={alt} />,
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
    // Block code (fenced with ```) has a language class or contains a newline
    if (lang || text.includes("\n")) return <CodeBlock lang={lang} code={text.replace(/\n$/, "")} />;
    return <code className="rounded-[4px] bg-muted px-1 py-px font-mono text-[12px]">{children}</code>;
  },
};

// Math: $…$ inline and $$…$$ blocks (\(…\) and \[…\] are turned into those first). KaTeX runs with its defaults that
// matter here: untrusted (no \href, \url or \includegraphics actions), and a formula it cannot read is shown as typed
// instead of breaking the message
const rehypePlugins: Parameters<typeof ReactMarkdown>[0]["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: "ignore", trust: false }],
  rehypeGallery,
];

/** Markdown body. While streaming, shows a typing indicator after the last element */
// Images on this machine (file:) and embedded images (data:image/) are kept; everything else is filtered as
// react-markdown does by default
type HastNode = { type: string; tagName?: string; value?: string; children?: HastNode[]; properties?: Record<string, unknown> };

const isImage = (n: HastNode) => n.type === "element" && n.tagName === "img";
const isBlank = (n: HastNode) => n.type === "text" && !n.value?.trim();
const isImageParagraph = (n: HastNode) =>
  n.type === "element" && n.tagName === "p" && !!n.children?.some(isImage) && n.children.every((c) => isImage(c) || isBlank(c));

/** Paragraphs that hold only images, one after another, become one gallery: square thumbnails side by side */
function rehypeGallery() {
  const walk = (node: HastNode) => {
    if (!node.children) return;
    const out: HastNode[] = [];
    let run: HastNode[] | null = null;
    for (const child of node.children) {
      if (isImageParagraph(child)) {
        if (!run) {
          run = [];
          out.push({ type: "element", tagName: "div", properties: { className: ["md-gallery"] }, children: run });
        }
        run.push(...child.children!.filter(isImage));
      } else if (run && isBlank(child)) {
        // the line breaks between the paragraphs
      } else {
        run = null;
        walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  return (tree: HastNode) => walk(tree);
}

const urlTransform = (url: string, key: string) => (/^file:/i.test(url) || (key === "src" && /^data:image\//i.test(url)) ? url : defaultUrlTransform(url));

export const Markdown = memo(function Markdown({ text, streaming, base }: { text: string; streaming?: boolean; base?: string }) {
  return (
    <div lang={contentLang(text)} className={cn("min-w-0 break-words select-text", streaming && "md-streaming")}>
      <ImageBase.Provider value={base}>
        <PreviewGroup>
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform}>
            {normalizeMath(text)}
          </ReactMarkdown>
        </PreviewGroup>
      </ImageBase.Provider>
    </div>
  );
});
