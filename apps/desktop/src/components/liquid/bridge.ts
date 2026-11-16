// 液架橋（出発点と実体のあいだに張る液体の首）の計算。描画から切り離してあるので、テストと絵での確認ができる。
//
// ふるまい（.claude/skills/no-ai-slop-ui の 4. 動き）:
//   - 首は、向かい合う面から直角に出て、S 字に曲がって相手の面へ直角に入る（液体は面に垂直に付く）
//   - 体積を保つように細くなり、切れる直前に急にくびれる（太さ ∝ (1 - 伸び/限界)^0.7）
//   - つながっているあいだは張力で実体を出発点の側へ引き留める。切れると、ためた分だけばねで前へ跳ねる
//   - 切れた後は、残った尾が両側へ吸い戻される
//   - 閉じるときは、近づくと首が伸びてつながり、張力で吸い込む
//   - 行き先が近くて伸びきらないとき（メニューなど）は、広がりきる直前にくびれて切れる
// 外部のライブラリに頼らない（Node でもそのまま動かせる: tools の絵での確認に使う）

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const fmt = (p: Pt) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
const center = (r: Rect): Pt => ({ x: (r.l + r.r) / 2, y: (r.t + r.b) / 2 });

/** 2 つの長方形のすきま（重なっていれば 0） */
export function rectGap(a: Rect, s: Rect): number {
  const dx = Math.max(0, s.l - a.r, a.l - s.r);
  const dy = Math.max(0, s.t - a.b, a.t - s.b);
  return Math.hypot(dx, dy);
}

type Side = "l" | "r" | "t" | "b";

/** r のどの面が other を向いているか（いちばん大きく離れている向き） */
function facing(r: Rect, other: Rect): Side {
  const seps: [number, Side][] = [
    [other.l - r.r, "r"],
    [r.l - other.r, "l"],
    [other.t - r.b, "b"],
    [r.t - other.b, "t"],
  ];
  seps.sort((x, y) => y[0] - x[0]);
  return seps[0][1];
}

export interface Foot {
  /** 足の中心（面の少し内側） */
  p: Pt;
  /** 面の外向きの法線 */
  n: Pt;
  /** 半分の幅 */
  w: number;
}

const NORMAL: Record<Side, Pt> = { r: { x: 1, y: 0 }, l: { x: -1, y: 0 }, b: { x: 0, y: 1 }, t: { x: 0, y: -1 } };
/** 足を面の内側へ少し入れる（出発点・実体で隠れるところで首を切る） */
const INSET = 2;

function footOn(r: Rect, side: Side, toward: Pt, half: number): Foot {
  const n = NORMAL[side];
  if (side === "l" || side === "r") {
    const y = clamp(toward.y, r.t + half, r.b - half);
    return { p: { x: (side === "r" ? r.r : r.l) - n.x * INSET, y }, n, w: half };
  }
  const x = clamp(toward.x, r.l + half, r.r - half);
  return { p: { x, y: (side === "b" ? r.b : r.t) - n.y * INSET }, n, w: half };
}

export interface Contact {
  a: Foot;
  s: Foot;
  gap: number;
}

/** 出発点 a と実体 s の、向かい合う面の足。重なっていれば null */
export function contact(a: Rect, s: Rect): Contact | null {
  const gap = rectGap(a, s);
  if (gap < 0.5) return null;
  const sideA = facing(a, s);
  const sideS = facing(s, a);
  const faceLen = (r: Rect, side: Side) => (side === "l" || side === "r" ? r.b - r.t : r.r - r.l);
  const ra = Math.min(a.r - a.l, a.b - a.t) / 2;
  const wa = Math.max(0, Math.min(ra * 0.87, faceLen(a, sideA) / 2 - 1));
  const ws = Math.max(0, Math.min(ra * 1.05, faceLen(s, sideS) / 2 - 1));
  if (wa <= 0 || ws <= 0) return null;
  const fa = footOn(a, sideA, center(s), wa);
  const fs = footOn(s, sideS, fa.p, ws);
  return { a: fa, s: fs, gap };
}

export interface Shape {
  /** 塗り（閉じた形。足は出発点・実体の中に入るので、そこは隠す前提） */
  fill: string;
  /** 両脇の輪郭（枠線の色で描く） */
  outline: string;
}

function ribbon(points: Pt[], tangents: Pt[], widths: number[]): Shape {
  const left: Pt[] = [];
  const right: Pt[] = [];
  points.forEach((p, i) => {
    const t = tangents[i];
    const len = Math.hypot(t.x, t.y) || 1;
    const n = { x: -t.y / len, y: t.x / len };
    left.push(add(p, n, widths[i]));
    right.push(add(p, n, -widths[i]));
  });
  const line = (ps: Pt[]) => ps.map((p, i) => `${i ? "L" : "M"} ${fmt(p)}`).join(" ");
  return {
    fill: `${line(left)} ${right
      .slice()
      .reverse()
      .map((p) => `L ${fmt(p)}`)
      .join(" ")} Z`,
    outline: `${line(left)} ${line(right)}`,
  };
}

const SAMPLES = 28;

/**
 * 首の形。中心線は、出発点の面から法線の向きに出て、実体の面へ法線の向きに入る 3 次曲線。
 * 太さは足で広く（メニスカス）、waist（0〜1 の位置）でいちばん細い
 */
export function neckShape(c: Contact, half: number, waist = 0.45): Shape {
  const P0 = c.a.p;
  const P3 = c.s.p;
  const d = Math.hypot(P3.x - P0.x, P3.y - P0.y);
  const k = Math.max(8, d * 0.5);
  const P1 = add(P0, c.a.n, k);
  const P2 = add(P3, c.s.n, k);
  const pts: Pt[] = [];
  const tan: Pt[] = [];
  const ws: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    pts.push({
      x: u * u * u * P0.x + 3 * u * u * t * P1.x + 3 * u * t * t * P2.x + t * t * t * P3.x,
      y: u * u * u * P0.y + 3 * u * u * t * P1.y + 3 * u * t * t * P2.y + t * t * t * P3.y,
    });
    tan.push({
      x: 3 * u * u * (P1.x - P0.x) + 6 * u * t * (P2.x - P1.x) + 3 * t * t * (P3.x - P2.x),
      y: 3 * u * u * (P1.y - P0.y) + 6 * u * t * (P2.y - P1.y) + 3 * t * t * (P3.y - P2.y),
    });
    const a = t < waist ? (waist - t) / waist : (t - waist) / (1 - waist);
    const foot = t < waist ? c.a.w : c.s.w;
    // 足で広がるメニスカス（指数が大きいほど、足のきわでだけ広がる）
    ws.push(half + (foot - half) * a ** 2.2);
  }
  return ribbon(pts, tan, ws);
}

/**
 * 切れた後に残る尾: 細い糸の先に玉ができて、根元へ吸い戻される形（引っ込む液の糸は先が玉になる）。
 * width は糸の付け根の半分の幅、len は糸の長さ
 */
export function tailShape(foot: Foot, width: number, len: number): Shape | null {
  if (len < 0.5 || width < 0.3) return null;
  const n = 20;
  const bead = width * 1.15;
  const thread = width * 0.45;
  const beadAt = Math.max(bead * 0.6, len - bead);
  const pts: Pt[] = [];
  const tan: Pt[] = [];
  const ws: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (len * i) / n;
    pts.push(add(foot.p, foot.n, x));
    tan.push(foot.n);
    // 付け根はメニスカスで広がり、糸は細く、先の玉で太くなって丸く閉じる
    const t = x / len;
    const th = x < beadAt ? thread * (1 + 1.2 * (1 - t) ** 6) : 0;
    const bd = Math.sqrt(Math.max(0, bead * bead - (x - beadAt) ** 2));
    ws.push(i === n ? 0 : Math.max(th, Math.min(bd, bead)));
  }
  return ribbon(pts, tan, ws);
}

// ---- ばね（Apple のばねの換算: stiffness = (2π/d)², damping = 4π(1−b)/d、質量 1）

class Spring {
  x: number;
  v = 0;
  k: number;
  c: number;
  constructor(x: number, duration: number, bounce: number) {
    this.x = x;
    this.k = ((2 * Math.PI) / duration) ** 2;
    this.c = (4 * Math.PI * (1 - bounce)) / duration;
  }
  step(target: number, dt: number) {
    // 半陰的オイラー。重いフレームでも発散しないように細かく刻む
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  settled(target: number) {
    return Math.abs(this.x - target) < 0.3 && Math.abs(this.v) < 2;
  }
}

export interface BridgeParams {
  /** これ以上離れると切れる（px） */
  breakGap: number;
  /** 閉じるとき、これより近づくとつながる（px） */
  connectGap: number;
  /** つながっているあいだ、すきまのこの割合だけ実体を引き留める */
  pullK: number;
  /** 引き留める量の上限（px） */
  pullCap: number;
}

/** 出発点の大きさから決める（太い出発点ほど長く伸びる） */
export function bridgeParams(anchor: Rect): BridgeParams {
  const r1 = Math.min(anchor.r - anchor.l, anchor.b - anchor.t) / 2;
  const breakGap = clamp(r1 * 6.5, 80, 200);
  return { breakGap, connectGap: breakGap * 0.55, pullK: 0.35, pullCap: Math.max(14, r1 * 1.8) };
}

/** 首のいちばん細いところの、足に対する太さの上限 */
const WAIST = 0.6;

export type BridgeMode = "attached" | "pinching" | "snapped" | "detached" | "forming";

export interface BridgeFrame {
  /** 首のいちばん細いところの太さの割合（0 なら描かない。足の幅に掛ける） */
  half: number;
  /** 切れた後の尾の残り（1 → 0） */
  tail: number;
  /** 実体を出発点の側へ引き留める量（px。負なら跳ねて前へ出ている） */
  pull: number;
}

/**
 * 液架橋の状態を時間で進める。開くときは「つながった状態」から、閉じるときは「離れた状態」から始める。
 * update には、引き留める前のすきま（raw）と、画面上のすきま（shown）、広がりの進み具合（grown, 0 → 1）を渡す
 */
export class BridgeSim {
  mode: BridgeMode;
  readonly opening: boolean;
  readonly p: BridgeParams;
  private form: Spring;
  private pinch = new Spring(1, 0.16, 0);
  private release = new Spring(0, 0.5, 0.45);
  private tailS = new Spring(1, 0.42, 0.2);
  pull = 0;
  /** 切れた瞬間の首の長さ（尾の長さに使う） */
  snapGap = 0;
  /** 切れた瞬間に呼ぶ（出発点を少し揺らすなど） */
  onSnap?: () => void;

  constructor(opening: boolean, p: BridgeParams) {
    this.opening = opening;
    this.p = p;
    this.mode = opening ? "attached" : "detached";
    this.form = new Spring(opening ? 1 : 0, 0.2, 0.3);
  }

  private snap(shown: number) {
    this.mode = "snapped";
    this.snapGap = shown;
    this.release.x = this.pull;
    this.release.v = 0;
    this.tailS.x = 1;
    this.tailS.v = 0;
    this.onSnap?.();
  }

  update(dt: number, raw: number, shown: number, grown: number): BridgeFrame {
    const { breakGap, connectGap, pullK, pullCap } = this.p;
    const tension = Math.min(raw * pullK, pullCap);
    switch (this.mode) {
      case "attached":
        this.pull = tension;
        if (shown >= breakGap) this.snap(shown);
        else if (this.opening && grown > 0.85) this.mode = "pinching";
        break;
      case "pinching":
        // くびれていくあいだも張力は保つ（切れた瞬間に跳ねる）
        this.pull = tension;
        this.pinch.step(0, dt);
        if (this.pinch.x < 0.05 || shown >= breakGap) this.snap(shown);
        break;
      case "snapped":
        this.pull = this.release.step(0, dt);
        this.tailS.step(0, dt);
        break;
      case "detached":
        this.pull = 0;
        if (shown <= connectGap) this.mode = "forming";
        break;
      case "forming":
        this.form.step(1, dt);
        this.pull = tension * Math.max(0, this.form.x);
        break;
    }
    const s = Math.min(1, Math.max(0, shown / breakGap));
    const thin = (1 - s) ** 0.7;
    const live = this.mode === "attached" || this.mode === "pinching" || this.mode === "forming";
    const formed = Math.max(0, Math.min(1, this.form.x));
    const pinched = this.mode === "pinching" ? Math.max(0, this.pinch.x) : 1;
    // 短いあいだも、くびれは足の 6 割まで（太い管に見えないように）
    return { half: live ? WAIST * thin * formed * pinched : 0, tail: this.mode === "snapped" ? Math.max(0, this.tailS.x) : 0, pull: this.pull };
  }

  /** 切れて、尾も戻り、跳ねも収まった（閉じるときは動きの終わりで片付けるので、ここでは true にならない） */
  get done(): boolean {
    return this.mode === "snapped" && this.release.settled(0) && this.tailS.x < 0.02;
  }
}
