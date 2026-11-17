// UI string localization (Japanese, English, Simplified Chinese; more languages only need a dictionary)
//
//   const t = useT();  t("sidebar.newSession")  t("diff.files", { count: 3 })
//
// - Dictionaries are one file per namespace (i18n/ja/*.ts is the source; other languages are type-checked to have the same keys)
// - Interpolation: "{name}". Plurals: "{count, plural, one {# file} other {# files}}" (Intl.PluralRules; # is the count)
// - The language comes from the language setting (auto follows macOS). Resolution and key conventions are in docs/i18n.md
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

/** Value for <html lang> (WebKit uses it to pick CJK glyphs and fonts) */
const HTML_LANG: Record<Lang, string> = { ja: "ja", en: "en", zh: "zh-CN" };

type Dict = typeof ja;
/** All "namespace.key" names (the type catches key typos) */
export type MessageKey = { [N in keyof Dict]: `${N & string}.${keyof Dict[N] & string}` }[keyof Dict];
export type Params = Record<string, string | number>;

const DICTS: Record<Lang, Record<string, Record<string, string>>> = { ja, en, zh };

/** Pick from the macOS (WebView) language, falling back to English. Chinese means Simplified only (Traditional locales aren't supported yet, so move on to the next candidate) */
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

/** Change the current language (when settings load or change) */
export function setLang(lang: Lang) {
  useLangStore.setState({ lang });
  if (typeof document !== "undefined") document.documentElement.lang = HTML_LANG[lang];
}

export const currentLang = () => useLangStore.getState().lang;

// ---- Formatting

/** Pick the branch of {count, plural, one {...} other {...}} using the language's plural rules */
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
    // Plurals first (they can contain {name})
    s = s.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, (_, k: string, body: string) => plural(lang, Number(params[k] ?? 0), body));
    s = s.replace(/\{(\w+)\}/g, (all, k: string) => (k in params ? String(params[k]) : all));
  }
  return s;
}

/** Look up in the current language. Missing languages or keys fall back to Japanese (and then to the key itself) */
export function t(key: MessageKey, params?: Params, lang: Lang = currentLang()): string {
  const [ns, k] = key.split(".") as [string, string];
  const template = DICTS[lang]?.[ns]?.[k] ?? DICTS.ja[ns]?.[k] ?? key;
  return format(lang, template, params);
}

export type T = (key: MessageKey, params?: Params) => string;

/** For use in components. Re-renders when the language changes */
export function useT(): T {
  const lang = useLangStore((s) => s.lang);
  return (key, params) => t(key, params, lang);
}

export function useLang(): Lang {
  return useLangStore((s) => s.lang);
}

/**
 * Guess the language of conversation text (agent output or your own messages). Set as lang, separately from the UI language, to get the right glyphs
 * (so Japanese text isn't drawn with Chinese glyphs in the Chinese UI). Kana means Japanese, Hangul means Korean, otherwise undetermined
 */
export function contentLang(text: string): string | undefined {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  return undefined;
}
