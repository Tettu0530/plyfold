import { describe, expect, it } from "vitest";

import { localUrls, normalizeUrl } from "./urls";

describe("urls", () => {
  it("finds local addresses in coloured dev server output", () => {
    const vite = "\x1b[32m  ➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: use --host to expose";
    expect(localUrls(vite)).toEqual(["http://localhost:5173/"]);
    expect(localUrls("Listening on http://0.0.0.0:3000. Also http://127.0.0.1:8080/api, http://localhost:3000")).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:8080/api",
    ]);
    expect(localUrls("see https://example.com")).toEqual([]);
  });

  it("normalizes typed addresses", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("claude.ai/new")).toBe("https://claude.ai/new");
    expect(normalizeUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    expect(normalizeUrl("192.168.1.5:3000")).toBe("http://192.168.1.5:3000/");
    expect(normalizeUrl("app.localhost:3000")).toBe("http://app.localhost:3000/");
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("  ")).toBeNull();
  });
});
