// ヘッドレスの Chrome を DevTools のプロトコルで動かし、仮想時間を 1 コマずつ進めて画面を撮る
//   node drive.mjs <port> <url> <操作の JS> <切り取り x,y,w,h> <コマ数> <出力 png>
import { writeFileSync } from "node:fs";
const [port, url, action, clipS, nS, out] = process.argv.slice(2);
const [cx, cy, cw, chh] = clipS.split(",").map(Number);
const n = Number(nS);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiters = new Map();
const events = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiters.has(d.id)) { waiters.get(d.id)(d); waiters.delete(d.id); }
  else if (d.method) events.push(d);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiters.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const waitEvent = async (name) => { for (;;) { const i = events.findIndex((e) => e.method === name); if (i >= 0) return events.splice(i, 1)[0]; await new Promise((r) => setTimeout(r, 10)); } };
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await waitEvent("Page.loadEventFired");
await new Promise((r) => setTimeout(r, 1500));
// 準備の操作（環境変数 PRE）: 時間を止める前に実行して、落ち着くまで待つ
if (process.env.PRE) {
  const r = await send("Runtime.evaluate", { expression: process.env.PRE, awaitPromise: true });
  if (r.result?.exceptionDetails) console.log("pre error", JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  await new Promise((r2) => setTimeout(r2, Number(process.env.PRE_WAIT ?? 1500)));
}
// LAST=1: 動きが落ち着いた画面を 1 枚だけ撮る。仮想時間は使わない（止まりやすいため）
if (process.env.LAST) {
  const r = await send("Runtime.evaluate", { expression: action, awaitPromise: true });
  if (r.result?.exceptionDetails) console.log("action error", JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  if (process.env.SHOW) console.log("action result", String(r.result?.result?.value).slice(0, 1500));
  await new Promise((r2) => setTimeout(r2, Number(process.env.SETTLE ?? 1200)));
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: cx, y: cy, width: cw, height: chh, scale: 1 } });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("wrote", out);
  ws.close();
  process.exit(0);
}
await send("Emulation.setVirtualTimePolicy", { policy: "pause" });
const r0 = await send("Runtime.evaluate", { expression: action, awaitPromise: false });
if (r0.result?.exceptionDetails) console.log("action error", JSON.stringify(r0.result.exceptionDetails).slice(0, 300));
if (process.env.SHOW) console.log("action result", String(r0.result?.result?.value).slice(0, 1500));
const shots = [];
for (let i = 0; i < n; i++) {
  await send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 16.667 });
  await waitEvent("Emulation.virtualTimeBudgetExpired");
  // 時間を止めたままだと、撮影に要る描画のコマが来ずに返事が止まることがある。
  // 3 秒待って返事がなければ、仮想時間を 1ms だけ進めてコマを出させる（何度でも）
  const pending = send("Page.captureScreenshot", { format: "png", clip: { x: cx, y: cy, width: cw, height: chh, scale: 1 } });
  let s = null;
  while (!s) {
    s = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!s) {
      await send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 1 });
      await waitEvent("Emulation.virtualTimeBudgetExpired");
    }
  }
  shots.push(s.result.data);
  // PROBE: コマごとに評価して出す（実体の形などを数値で見る）
  if (process.env.PROBE) {
    const pr = await send("Runtime.evaluate", { expression: process.env.PROBE });
    console.log(`${Math.round((i + 1) * 16.7)}ms`, pr.result?.result?.value ?? JSON.stringify(pr.result?.exceptionDetails ?? "").slice(0, 200));
  }
}
// コマを並べた 1 枚にする
await send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 100000 });
const cols = Number(process.env.COLS ?? 4);
const html = `<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:4px">${shots.map((d, i) => `<div style="position:relative"><img src="data:image/png;base64,${d}" style="display:block"><span style="position:absolute;left:4px;top:2px;color:#f0f;font:11px Menlo">${Math.round((i + 1) * 16.7)}ms</span></div>`).join("")}</body>`;
await send("Page.navigate", { url: "about:blank" });
await new Promise((r) => setTimeout(r, 300));
await send("Runtime.evaluate", { expression: `document.open();document.write(${JSON.stringify(html)});document.close();` });
await new Promise((r) => setTimeout(r, 500));
const rows = Math.ceil(n / cols);
const sheet = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: cols * (cw + 4), height: rows * (chh + 4), scale: 1 }, captureBeyondViewport: true });
writeFileSync(out, Buffer.from(sheet.result.data, "base64"));
console.log("wrote", out);
ws.close();
