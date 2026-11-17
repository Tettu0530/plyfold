import { describe, expect, it } from "vitest";

import { en } from "./en";
import { format, t } from "./index";
import { ja } from "./ja";
import { zh } from "./zh";

describe("i18n", () => {
  it("interpolates and picks plural forms by language", () => {
    const tpl = "{count, plural, one {# file} other {# files}} in {repo}";
    expect(format("en", tpl, { count: 1, repo: "plyfold" })).toBe("1 file in plyfold");
    expect(format("en", tpl, { count: 3, repo: "plyfold" })).toBe("3 files in plyfold");
    expect(format("ja", "{count, plural, other {# 件}}", { count: 1 })).toBe("1 件");
    expect(format("en", "{count, plural, =0 {none} other {#}}", { count: 0 })).toBe("none");
  });

  it("looks up by language and falls back to Japanese", () => {
    expect(t("sidebar.newSession", undefined, "en")).toBe("New session");
    expect(t("sidebar.newSession", undefined, "ja")).toBe("新しいセッション");
  });

  it("has an entry in every language for every Japanese key, and nothing extra", () => {
    for (const other of [en, zh] as Record<string, Record<string, string>>[]) {
      for (const [ns, dict] of Object.entries(ja)) {
        const e = other[ns];
        expect(Object.keys(e ?? {}).sort(), ns).toEqual(Object.keys(dict).sort());
        for (const [k, v] of Object.entries(e ?? {})) expect(v.trim(), `${ns}.${k}`).not.toBe("");
      }
    }
  });
});
