// Renders the distance-field merge (sdf.ts) as a frame-by-frame PNG, evaluating the GPU formula per pixel on the CPU
//   node tools/liquid-probe/sdf-film.mjs <absolute path to sdf.ts> <row|far|chip> <out.png> [tail]
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const { boxOf, sdBox, smin, mergeWidth, mergeAt, Adhesion, PeelSpring } = await import(process.argv[2]);
const rectGap = (a, b) => Math.hypot(Math.max(0, b[0] - a[2], a[0] - b[2]), Math.max(0, b[1] - a[3], a[1] - b[3]));
const scenario = process.argv[3] ?? "row";
const out = process.argv[4];
const withTail = process.argv[5] === "tail";
// zoom: the first 12 frames at 1/60 s steps, at 1x, around the seam only
const zoom = process.argv[5] === "zoom" || process.argv[6] === "zoom";

const S = (d, b) => ({ k: (2 * Math.PI / d) ** 2, c: (4 * Math.PI * (1 - b)) / d, x: 0, v: 0 });
const step = (s, target, dt) => { for (let i = 0; i < 8; i++) { const h = dt / 8; s.v += (-s.k * (s.x - target) - s.c * s.v) * h; s.x += s.v * h; } return s.x; };

const scen = {
  row: { A: [8, 120, 232, 176], T: [241, 40, 841, 700], view: [0, 60, 640, 400], tr: 0 },
  far: { A: [8, 120, 232, 176], T: [841, 40, 1440, 700], view: [0, 40, 960, 520], tr: 0 },
  chip: { A: [300, 400, 380, 424], T: [296, 290, 456, 394], view: [250, 270, 260, 180], tr: 8 },
}[scenario];
const [al, at, ar, ab] = scen.A;
const A = boxOf(al, at, ar, ab, 8);
const k = mergeWidth(Math.min(ar - al, ab - at));
const ac = { x: A.cx, y: A.cy, w: ar - al, h: ab - at };
const [tl, tt, trr, tb] = scen.T;
const bc = { x: (tl + trr) / 2, y: (tt + tb) / 2, w: trr - tl, h: tb - tt };

// colors (0–1)
const SIDEBAR = [0x17, 0x17, 0x17], MAIN = [0x0a, 0x0a, 0x0a], ACCENT = [0x26, 0x26, 0x26];
const SURF = scenario === "chip" ? [0x17, 0x17, 0x17] : [0x0a, 0x0a, 0x0a];
const BORDER = [255, 255, 255, 0.1];

const peel = !process.argv.includes("nopeel");
const p = peel ? new PeelSpring(0.35, 0.3) : S(0.35, 0.3), q = S(0.42, 0.3), tailS = { x: S(0.55, 0.15), y: S(0.55, 0.15) };
tailS.x.x = ac.x; tailS.y.x = ac.y;
const dt = 1 / 60;
const frames = [];
const adh = new Adhesion(true);
for (let i = 0; i < 40; i++) {
  const t = i * dt;
  if (peel) p.step(1, dt); else step(p, 1, dt);
  if (t >= 0.12) step(q, 1, dt);
  let cx = ac.x + (bc.x - ac.x) * p.x, cy = ac.y + (bc.y - ac.y) * p.x;
  const w = ac.w + (bc.w - ac.w) * q.x, h = ac.h + (bc.h - ac.h) * q.x;
  const kNow = mergeAt(k, Math.min(1, Math.max(0, q.x)));
  const rawGap = rectGap(scen.A, [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
  const pull = process.argv.includes("loose") ? 0 : adh.update(dt, rawGap, kNow);
  { const dx = cx - ac.x, dy = cy - ac.y, d = Math.hypot(dx, dy); if (d > 1) { cx -= (dx / d) * pull; cy -= (dy / d) * pull; } }
  step(tailS.x, cx, dt); step(tailS.y, cy, dt);
  const travel = Math.min(1, Math.max(0, p.x));
  const rad = travel < 0.75 ? 8 + (16 - 8) * Math.min(1, travel / 0.25) : 16 + (scen.tr - 16) * Math.min(1, (travel - 0.75) / 0.25);
  const look = Math.min(1, Math.max(0, q.x));
  frames.push({ t, k: kNow, S: boxOf(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, Math.min(rad, w / 2, h / 2)), tail: { x: tailS.x.x, y: tailS.y.x }, look });
}

const ZOOM = { row: [150, 90, 330, 200], far: [150, 80, 420, 200], chip: [270, 300, 220, 140] };
const [vx, vy, vw, vh] = zoom ? ZOOM[scenario] : scen.view;
const sc = zoom ? 1 : 0.5, cw = Math.round(vw * sc), ch = Math.round(vh * sc), cols = zoom ? 3 : 4, gap = 6;
const pick = zoom ? frames.slice(0, 12) : frames.filter((_, i) => i % 2 === 0).slice(0, 16);
const W = cols * (cw + gap), H = Math.ceil(pick.length / cols) * (ch + gap);
const img = new Uint8Array(W * H * 3);
const mix = (a, b, m) => a.map((v, i) => v + (b[i] - v) * m);
pick.forEach((fr, idx) => {
  const ox = (idx % cols) * (cw + gap), oy = Math.floor(idx / cols) * (ch + gap);
  const surfCol = mix(ACCENT, SURF, fr.look);
  // tail: a circle that trails the body's center (same idea as Fizzy's drop). Faster motion pulls it further out into a teardrop
  const tr = Math.min(fr.S.hw, fr.S.hh, Math.min(ac.w, ac.h) * 0.5);
  const tail = boxOf(fr.tail.x - tr, fr.tail.y - tr, fr.tail.x + tr, fr.tail.y + tr, tr);
  for (let py = 0; py < ch; py++) for (let px = 0; px < cw; px++) {
    const x = vx + (px + 0.5) / sc, y = vy + (py + 0.5) / sc;
    let col = x < 240 ? SIDEBAR : MAIN;
    const dA = sdBox(x, y, A);
    let dS = sdBox(x, y, fr.S);
    if (withTail) dS = smin(dS, sdBox(x, y, tail), k * 0.8).d;
    const u = smin(dA, dS, fr.k);
    // antialias the edge over one screen px (1/sc, since the image is scaled down)
    const aa = 1 / sc;
    const cov = Math.min(1, Math.max(0, 0.5 - u.d / aa));
    const covA = Math.min(1, Math.max(0, 0.5 - dA / aa));
    if (cov > 0) {
      const fill = mix(ACCENT, surfCol, u.m);
      col = mix(col, fill, cov);
      // edge line: the body's border color. Fades out on the origin side (small m)
      const line = Math.exp(-Math.max(0, -u.d) / 0.9) * cov * BORDER[3] * fr.look * u.m;
      col = mix(col, BORDER.slice(0, 3), line);
    }
    // the origin (the real button) is drawn on top
    if (covA > 0) col = mix(col, ACCENT, covA);
    const o = ((oy + py) * W + ox + px) * 3;
    img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2];
  }
});
// write the PNG
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf) => { let c = -1; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log(`k=${k} frames=${pick.length} -> ${out}`);
