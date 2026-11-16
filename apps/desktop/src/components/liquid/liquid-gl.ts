// 液体の融合を GPU で描く。画面全体に 1 枚の WebGL2 のキャンバスを重ね（クリックは素通し）、
// 動いている分離アニメーションごとに、出発点と実体の距離場を smin で 1 つにして塗る（式は sdf.ts と同じ）。
//
//   - 塗り・枠線・影は、smin の混ざり具合で出発点の見た目と実体の見た目を混ぜる
//   - 出発点（本物のボタン）の中は塗らない（本物の上に重ねない。出発点から生えて見える）
//   - 縁は 1 デバイス px で滑らかにする

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface BlobFrame {
  /** 出発点の箱（CSS px） */
  a: { l: number; t: number; r: number; b: number; radius: number };
  /** 実体の箱（CSS px） */
  s: { l: number; t: number; r: number; b: number; radius: number };
  /** つながる幅（px） */
  k: number;
  fillA: Rgba;
  fillS: Rgba;
  lineA: Rgba;
  lineS: Rgba;
  shadow: { x: number; y: number; blur: number; color: Rgba };
  opacity: number;
}

export interface Blob {
  /** 毎フレーム呼ぶ。null なら今は描かない */
  frame(dt: number): BlobFrame | null;
}

const VERT = `#version 300 es
uniform vec4 uRect;   // 描く範囲 l, t, r, b（CSS px）
uniform vec2 uView;   // 画面の大きさ（CSS px）
void main() {
  vec2 c = vec2((gl_VertexID & 1) == 0 ? uRect.x : uRect.z, (gl_VertexID & 2) == 0 ? uRect.y : uRect.w);
  gl_Position = vec4(c.x / uView.x * 2.0 - 1.0, 1.0 - c.y / uView.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uView;
uniform float uDpr;
uniform vec4 uA; uniform float uAr;   // 出発点: 中心 xy、半分の幅・高さ zw、角の丸み
uniform vec4 uS; uniform float uSr;   // 実体
uniform float uK;
uniform vec4 uFillA; uniform vec4 uFillS;
uniform vec4 uLineA; uniform vec4 uLineS;
uniform vec4 uShadow; uniform vec3 uShadowGeo;   // 色、ずれ x・y とぼかし
uniform float uOpacity;
out vec4 outColor;

float sdBox(vec2 p, vec4 b, float r) {
  vec2 q = abs(p - b.xy) - b.zw + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
// iq の 2 次の smin。y は「実体の割合」
vec2 smin(float a, float b, float k) {
  if (k <= 0.0) return a < b ? vec2(a, 0.0) : vec2(b, 1.0);
  float h = max(k - abs(a - b), 0.0) / k;
  float d = min(a, b) - h * h * k * 0.25;
  float m = a < b ? 0.5 * h * h : 1.0 - 0.5 * h * h;
  return vec2(d, m);
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uView.y * uDpr - gl_FragCoord.y) / uDpr;
  float dA = sdBox(p, uA, uAr);
  vec2 u = smin(dA, sdBox(p, uS, uSr), uK);
  float px = 1.0 / uDpr;
  float cov = clamp(0.5 - u.x / px, 0.0, 1.0);
  // 枠線: 縁から内側 1px の帯（CSS の border と同じ位置）
  float band = cov - clamp(0.5 - (u.x + 1.0) / px, 0.0, 1.0);
  vec4 fill = mix(uFillA, uFillS, u.y);
  vec4 line = mix(uLineA, uLineS, u.y);
  // 影: ずらした位置の融合した形から、ぼかして落とす（実体の側だけ）
  vec2 ps = p - uShadowGeo.xy;
  vec2 us = smin(sdBox(ps, uA, uAr), sdBox(ps, uS, uSr), uK);
  float sig = max(uShadowGeo.z * 0.5, 0.5);
  float sh = uShadow.a * us.y * (1.0 - smoothstep(-sig, sig * 2.0, us.x));
  // 重ねる（乗算済みの色）: 影 → 塗り → 枠線
  float fa = fill.a * cov;
  vec4 c = vec4(uShadow.rgb * sh, sh) * (1.0 - fa) + vec4(fill.rgb * fa, fa);
  float la = line.a * band;
  c = vec4(line.rgb * la, la) + c * (1.0 - la);
  // 出発点の中は塗らない
  c *= 1.0 - clamp(0.5 - dA / px, 0.0, 1.0);
  outColor = c * uOpacity;
}`;

interface Scene {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
  blobs: Set<Blob>;
  raf: number;
  last: number;
}

const g = globalThis as { __plyfoldLiquidScene?: Scene | null };

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
  return sh;
}

function createScene(): Scene | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, { position: "fixed", inset: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: "55" });
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) return null;
  try {
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    const names = ["uRect", "uView", "uDpr", "uA", "uAr", "uS", "uSr", "uK", "uFillA", "uFillS", "uLineA", "uLineS", "uShadow", "uShadowGeo", "uOpacity"];
    const loc = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));
    gl.bindVertexArray(gl.createVertexArray());
    document.body.appendChild(canvas);
    return { canvas, gl, prog, loc, blobs: new Set(), raf: 0, last: 0 };
  } catch (e) {
    console.warn("液体の描画（WebGL）を使えません", e);
    return null;
  }
}

/** 共有のキャンバス。WebGL2 が使えなければ null（呼び出し側は DOM の描画に戻す） */
function scene(): Scene | null {
  if (g.__plyfoldLiquidScene === undefined) g.__plyfoldLiquidScene = createScene();
  return g.__plyfoldLiquidScene;
}

export function liquidGlSupported(): boolean {
  return scene() !== null;
}

function render(sc: Scene) {
  // 時刻は performance.now（motion と同じ時計）
  const now = performance.now();
  const { gl, canvas, loc } = sc;
  const dt = sc.last ? Math.min(1 / 30, (now - sc.last) / 1000) : 1 / 60;
  sc.last = now;
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const W = Math.round(vw * dpr);
  const H = Math.round(vh * dpr);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(sc.prog);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform2f(loc.uView, vw, vh);
  gl.uniform1f(loc.uDpr, dpr);
  const col = (n: string, c: Rgba) => gl.uniform4f(loc[n], c.r, c.g, c.b, c.a);
  for (const blob of sc.blobs) {
    const f = blob.frame(dt);
    if (!f || f.opacity <= 0) continue;
    const box = (b: BlobFrame["a"]) => {
      const hw = Math.max(0, (b.r - b.l) / 2);
      const hh = Math.max(0, (b.b - b.t) / 2);
      return [(b.l + b.r) / 2, (b.t + b.b) / 2, hw, hh, Math.max(0, Math.min(b.radius, hw, hh))] as const;
    };
    const A = box(f.a);
    const S = box(f.s);
    gl.uniform4f(loc.uA, A[0], A[1], A[2], A[3]);
    gl.uniform1f(loc.uAr, A[4]);
    gl.uniform4f(loc.uS, S[0], S[1], S[2], S[3]);
    gl.uniform1f(loc.uSr, S[4]);
    gl.uniform1f(loc.uK, f.k);
    col("uFillA", f.fillA);
    col("uFillS", f.fillS);
    col("uLineA", f.lineA);
    col("uLineS", f.lineS);
    col("uShadow", f.shadow.color);
    gl.uniform3f(loc.uShadowGeo, f.shadow.x, f.shadow.y, f.shadow.blur);
    gl.uniform1f(loc.uOpacity, f.opacity);
    // 描く範囲: 2 つの箱と、融合のふくらみ（k/4）と影
    const pad = f.k / 4 + f.shadow.blur * 1.5 + Math.max(Math.abs(f.shadow.x), Math.abs(f.shadow.y)) + 2;
    gl.uniform4f(loc.uRect, Math.min(f.a.l, f.s.l) - pad, Math.min(f.a.t, f.s.t) - pad, Math.max(f.a.r, f.s.r) + pad, Math.max(f.a.b, f.s.b) + pad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function loop(sc: Scene) {
  const tick = () => {
    if (sc.blobs.size === 0) {
      sc.gl.clearColor(0, 0, 0, 0);
      sc.gl.clear(sc.gl.COLOR_BUFFER_BIT);
      sc.raf = 0;
      sc.last = 0;
      return;
    }
    render(sc);
    sc.raf = requestAnimationFrame(tick);
  };
  if (!sc.raf) sc.raf = requestAnimationFrame(tick);
}

/** 描くものを足す。返り値を呼ぶと外す */
export function addBlob(blob: Blob): () => void {
  const sc = scene();
  if (!sc) return () => {};
  sc.blobs.add(blob);
  loop(sc);
  return () => {
    sc.blobs.delete(blob);
  };
}

// ---- 色と影の文字列を読む（motion が混ぜた "rgba(…)" をそのまま受け取る）

export function parseColor(s: string): Rgba {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g2, b, a = "1"] = m[1].split(/[\s,/]+/).filter(Boolean);
    return { r: Number(r) / 255, g: Number(g2) / 255, b: Number(b) / 255, a: Number(a) };
  }
  const h = s.match(/^#([0-9a-f]{6})$/i);
  if (h) {
    const n = parseInt(h[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  return { r: 0, g: 0, b: 0, a: 0 };
}

/** "0px 16px 48px rgba(0,0,0,.55)" の最初の影 */
export function parseShadow(s: string): BlobFrame["shadow"] {
  const color = parseColor(s);
  const nums = s.replace(/rgba?\([^)]*\)/, "").match(/-?[\d.]+px/g)?.map((v) => parseFloat(v)) ?? [];
  return { x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, color };
}
