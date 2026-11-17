import { describe, expect, it } from "vitest";

import { isSendKey } from "./keys";

// テストは node で動くので、キーの出来事は形だけの値で作る
const key = (o: Partial<KeyboardEvent>) => ({ key: "Enter", isComposing: false, keyCode: 13, shiftKey: false, metaKey: false, ctrlKey: false, ...o }) as KeyboardEvent;

describe("keys", () => {
  it("treats the Enter that commits Japanese input as IME, not send", () => {
    expect(isSendKey(key({ isComposing: true }), "enter")).toBe(false);
    // WebKit: 確定の Enter は isComposing が false で、keyCode が 229
    expect(isSendKey(key({ keyCode: 229 }), "enter")).toBe(false);
  });

  it("follows the send key setting", () => {
    expect(isSendKey(key({}), "enter")).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), "enter")).toBe(false);
    expect(isSendKey(key({}), "cmd_enter")).toBe(false);
    expect(isSendKey(key({ metaKey: true }), "cmd_enter")).toBe(true);
    expect(isSendKey(key({ metaKey: true }), "enter")).toBe(true);
    expect(isSendKey(key({ key: "a" }), "enter")).toBe(false);
  });
});
