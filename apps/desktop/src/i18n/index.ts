// 画面の文言の多言語化（日本語、英語。中国語と韓国語は辞書を足すだけで増やせる）
//
//   const t = useT();  t("sidebar.newSession")  t("diff.files", { count: 3 })
//
// - 辞書は名前空間ごとのファイル（i18n/ja/*.ts が元。ほかの言語は同じキーを型で強いる）
// - 差し込み: "{name}"。複数形: "{count, plural, one {# file} other {# files}}"（Intl.PluralRules。# は数）
// - 言語は設定の language（auto なら macOS の言語）。決め方とキーの決まりは docs/i18n.md
import { create } from "zustand";

import { en } from "./en";
import { ja } from "./ja";
import { zh } from "./zh";

export type Lang = "ja" | "en" | "zh";
export type LangSetting = "auto" | Lang;

export const LANGS: { value: Lang; label: string }[] = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
];

/** <html lang> に入れる値（WebKit が漢字の字形とフォントを選ぶ手がかりになる） */
const HTML_LANG: Record<Lang, string> = { ja: "ja", en: "en", zh: "zh-CN" };

type Dict = typeof ja;
/** "名前空間.キー" の一覧（型でキーの打ち間違いを防ぐ） */
export type MessageKey = { [N in keyof Dict]: `${N & string}.${keyof Dict[N] & string}` }[keyof Dict];
export type Params = Record<string, string | number>;

const DICTS: Record<Lang, Record<string, Record<string, string>>> = { ja, en, zh };

/** macOS（WebView）の言語から決める。分からなければ英語。中国語は簡体字だけ（繁体字の地域はまだないので次の候補へ） */
export function detectLang(): Lang {
  const langs = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const l of langs) {
    const tag = l?.toLowerCase() ?? "";
    const base = tag.split("-")[0];
    if (base === "ja" || base === "en") return base;
    if (base === "zh" && !/hant|-tw|-hk|-mo/.test(tag)) return "zh";
  }
  return "en";
}

export const resolveLang = (s: LangSetting | undefined | null): Lang => (s === "ja" || s === "en" || s === "zh" ? s : detectLang());

const useLangStore = create<{ lang: Lang }>(() => ({ lang: detectLang() }));

/** 今の言語を変える（設定を読んだとき、変えたとき） */
export function setLang(lang: Lang) {
  useLangStore.setState({ lang });
  if (typeof document !== "undefined") document.documentElement.lang = HTML_LANG[lang];
}

export const currentLang = () => useLangStore.getState().lang;

// ---- 書式

/** {count, plural, one {...} other {...}} の中を、言語の複数形の規則で選ぶ */
function plural(lang: Lang, n: number, body: string): string {
  const forms: Record<string, string> = {};
  const re = /(=\d+|zero|one|two|few|many|other)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  for (let m = re.exec(body); m; m = re.exec(body)) forms[m[1]] = m[2];
  const pick = forms[`=${n}`] ?? forms[new Intl.PluralRules(lang).select(n)] ?? forms.other ?? "";
  return pick.replace(/#/g, String(n));
}

export function format(lang: Lang, template: string, params?: Params): string {
  let s = template;
  if (params) {
    // 複数形を先に（中に {name} を含められる）
    s = s.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, (_, k: string, body: string) => plural(lang, Number(params[k] ?? 0), body));
    s = s.replace(/\{(\w+)\}/g, (all, k: string) => (k in params ? String(params[k]) : all));
  }
  return s;
}

/** 今の言語で引く。辞書にない言語やキーは日本語に戻る（それもなければキーをそのまま） */
export function t(key: MessageKey, params?: Params, lang: Lang = currentLang()): string {
  const [ns, k] = key.split(".") as [string, string];
  const template = DICTS[lang]?.[ns]?.[k] ?? DICTS.ja[ns]?.[k] ?? key;
  return format(lang, template, params);
}

export type T = (key: MessageKey, params?: Params) => string;

/** 部品の中で使う。言語が変わると描き直す */
export function useT(): T {
  const lang = useLangStore((s) => s.lang);
  return (key, params) => t(key, params, lang);
}

export function useLang(): Lang {
  return useLangStore((s) => s.lang);
}

/**
 * 会話の本文（エージェントの出力や自分の発言）の言語の見当。画面の言語とは別に、本文の字形を正しくするため lang に入れる
 * （中国語の画面で日本語の本文を中国語の字形で描かない）。かなを含めば日本語、ハングルなら韓国語、ほかは決めない
 */
export function contentLang(text: string): string | undefined {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  return undefined;
}
