import { describe, expect, it } from "vitest";

import { imageSource } from "./imageSrc";

describe("images in answers", () => {
  it("reads files on this machine, relative to the session's folder", () => {
    expect(imageSource("slides/L01/p-03.png", "/work/course")).toEqual({ kind: "file", path: "/work/course/slides/L01/p-03.png" });
    expect(imageSource("./a b.png", "/w/")).toEqual({ kind: "file", path: "/w/a b.png" });
    expect(imageSource("shots/%E5%9B%B3.png", "/w")).toEqual({ kind: "file", path: "/w/shots/図.png" });
    expect(imageSource("/tmp/x.png", undefined)).toEqual({ kind: "file", path: "/tmp/x.png" });
    expect(imageSource("~/x.png", undefined)).toEqual({ kind: "file", path: "~/x.png" });
    expect(imageSource("file:///Users/me/x.png", undefined)).toEqual({ kind: "file", path: "/Users/me/x.png" });
    expect(imageSource("file:///C:/Users/me/x.png", undefined)).toEqual({ kind: "file", path: "C:/Users/me/x.png" });
    expect(imageSource("img\\x.png", "C:\\work")).toEqual({ kind: "file", path: "C:\\work\\img\\x.png" });
  });

  it("shows data URLs, and does not fetch from the web", () => {
    expect(imageSource("data:image/png;base64,AAAA", undefined)).toEqual({ kind: "data", src: "data:image/png;base64,AAAA" });
    expect(imageSource("https://example.com/x.png", "/w")).toBeNull();
    expect(imageSource("http://example.com/x.png", "/w")).toBeNull();
    // A relative path needs the session's folder
    expect(imageSource("x.png", undefined)).toBeNull();
    expect(imageSource(undefined, "/w")).toBeNull();
  });
});
