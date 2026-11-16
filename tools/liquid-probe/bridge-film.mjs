// 液架橋の動きを、コマ送りの絵（SVG）にする。ばねは app と同じ換算で、半陰的オイラーで進める
import { writeFileSync } from "node:fs";
const m = await import(process.argv[2]);
const { BridgeSim, bridgeParams, contact, neckShape, tailShape, rectGap } = m;
const scenario = process.argv[3] ?? "row";
const out = process.argv[4];

const S = (d, b) => ({ k: (2 * Math.PI / d) ** 2, c: (4 * Math.PI * (1 - b)) / d, x: 0, v: 0 });
const step = (s, target, dt) => { for (let i = 0; i < 8; i++) { const h = dt / 8; s.v += (-s.k * (s.x - target) - s.c * s.v) * h; s.x += s.v * h; } return s.x; };

const scen = {
  row: { A: { l: 8, t: 120, r: 232, b: 176 }, T: { l: 241, t: 40, r: 841, b: 700 }, view: [0, 40, 640, 380] },
  far: { A: { l: 8, t: 120, r: 232, b: 176 }, T: { l: 841, t: 40, r: 1440, b: 700 }, view: [0, 40, 900, 500] },
  chip: { A: { l: 300, t: 400, r: 380, b: 424 }, T: { l: 296, t: 290, r: 456, b: 394 }, view: [220, 260, 320, 200] },
}[scenario];
const { A, T } = scen;
const ac = { x: (A.l + A.r) / 2, y: (A.t + A.b) / 2, w: A.r - A.l, h: A.b - A.t };
const bc = { x: (T.l + T.r) / 2, y: (T.t + T.b) / 2, w: T.r - T.l, h: T.b - T.t };
const sim = new BridgeSim(true, bridgeParams(A));
let lastC = null;
const p = S(0.35, 0.3), q = S(0.42, 0.3);
const dt = 1 / 60;
const frames = [];
for (let i = 0; i < 48; i++) {
  const t = i * dt;
  step(p, 1, dt);
  if (t >= 0.12) step(q, 1, dt);
  const cx = ac.x + (bc.x - ac.x) * p.x, cy = ac.y + (bc.y - ac.y) * p.x;
  const w = ac.w + (bc.w - ac.w) * q.x, h = ac.h + (bc.h - ac.h) * q.x;
  const raw = { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
  let dx = cx - ac.x, dy = cy - ac.y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  const pullNow = sim.pull;
  const shown = { l: raw.l - dx * pullNow, r: raw.r - dx * pullNow, t: raw.t - dy * pullNow, b: raw.b - dy * pullNow };
  const fr = sim.update(dt, rectGap(A, raw), rectGap(A, shown), Math.min(1, q.x));
  const c = contact(A, shown); lastC = c ?? lastC;
  let neck = null, tails = [];
  if (c && fr.half > 0) neck = neckShape(c, fr.half * Math.min(c.a.w, c.s.w));
  if (c && fr.tail > 0) {
    const t1 = tailShape(c.a, c.a.w * 0.45 * Math.sqrt(fr.tail), sim.snapGap * 0.45 * fr.tail);
    const t2 = tailShape(c.s, c.s.w * 0.45 * Math.sqrt(fr.tail), sim.snapGap * 0.4 * fr.tail * fr.tail);
    tails = [t1, t2].filter(Boolean);
  }
  frames.push({ t, shown, neck, tails, mode: sim.mode, half: fr.half, pull: fr.pull });
}
const [vx, vy, vw, vh] = scen.view;
const pick = frames.filter((_, i) => i % 2 === 0).slice(0, 20);
const cols = 4, sc = 0.5, cw = vw * sc, ch = vh * sc, pad = 18;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * (cw + 8)}" height="${Math.ceil(pick.length / cols) * (ch + pad + 8)}" style="background:#000">`;
pick.forEach((fr, i) => {
  const ox = (i % cols) * (cw + 8), oy = Math.floor(i / cols) * (ch + pad + 8);
  const id = `m${i}`;
  svg += `<g transform="translate(${ox},${oy + pad})"><svg width="${cw}" height="${ch}" viewBox="${vx} ${vy} ${vw} ${vh}">`;
  svg += `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#0a0a0a"/><rect x="0" y="0" width="240" height="1000" fill="#171717"/>`;
  const s = fr.shown;
  svg += `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="5000" height="5000"><rect x="-2000" y="-2000" width="5000" height="5000" fill="white"/><rect x="${A.l}" y="${A.t}" width="${A.r - A.l}" height="${A.b - A.t}" rx="8" fill="black"/><rect x="${s.l + 1}" y="${s.t + 1}" width="${s.r - s.l - 2}" height="${s.b - s.t - 2}" rx="15" fill="black"/></mask></defs>`;
  svg += `<rect x="${s.l}" y="${s.t}" width="${s.r - s.l}" height="${s.b - s.t}" rx="16" fill="#1f1f1f" stroke="rgba(255,255,255,0.35)"/>`;
  svg += `<g mask="url(#${id})">`;
  if (fr.neck) svg += `<path d="${fr.neck.fill}" fill="#1f1f1f"/><path d="${fr.neck.outline}" fill="none" stroke="rgba(255,255,255,0.35)"/>`;
  for (const tl of fr.tails) svg += `<path d="${tl.fill}" fill="#1f1f1f"/><path d="${tl.outline}" fill="none" stroke="rgba(255,255,255,0.35)"/>`;
  svg += `</g><rect x="${A.l}" y="${A.t}" width="${A.r - A.l}" height="${A.b - A.t}" rx="8" fill="#262626"/>`;
  svg += `</svg><text x="2" y="-5" fill="#aaa" font-size="11" font-family="Menlo">${Math.round(fr.t * 1000)}ms ${fr.mode} pull ${fr.pull.toFixed(0)} half ${fr.half.toFixed(2)}</text></g>`;
});
svg += `</svg>`;
writeFileSync(out, svg);
console.log(frames.map((f) => `${Math.round(f.t * 1000)}:${f.mode}:${f.pull.toFixed(1)}`).filter((_, i) => i % 3 === 0).join(" "));
