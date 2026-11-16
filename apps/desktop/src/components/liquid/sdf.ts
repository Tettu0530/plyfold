// 距離場（SDF）による液体の融合。Liquid Glass と同じ考え方: 形ごとの距離場を「滑らかな最小値（smin）」で
// ひとつにすると、近づいた形の縁が互いへ寄り、さらに近づくと首でつながり、離れると首がくびれて切れる。
//
//   - 角丸の箱の距離場: iq の sdRoundBox
//   - 融合: iq の 2 次の smin。k は「どこまで離れてもつながるか」の幅（spacing に当たる）。
//     すきまが k/2 より狭いとつながり、k より狭いと縁が寄る（GlassEffectContainer の spacing の実測と一致）
//   - 色: smin の混ざり具合 m で、2 つの形の色を混ぜる
//
// GPU の描画（liquid-gl.ts のシェーダー）と同じ式を、確認用（テストとコマ送りの絵）に JS でも持つ。外部に頼らない

export interface Box {
  /** 中心と、半分の幅・高さ（px） */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  /** 角の丸み（px） */
  r: number;
}

export function boxOf(l: number, t: number, r: number, b: number, radius: number): Box {
  const hw = Math.max(0, (r - l) / 2);
  const hh = Math.max(0, (b - t) / 2);
  return { cx: (l + r) / 2, cy: (t + b) / 2, hw, hh, r: Math.max(0, Math.min(radius, hw, hh)) };
}

/** 角丸の箱までの符号付き距離（中が負） */
export function sdBox(x: number, y: number, b: Box): number {
  const qx = Math.abs(x - b.cx) - b.hw + b.r;
  const qy = Math.abs(y - b.cy) - b.hh + b.r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - b.r;
}

/** 2 次の滑らかな最小値。m は「b の割合」（0 = a だけ、1 = b だけ） */
export function smin(a: number, b: number, k: number): { d: number; m: number } {
  if (k <= 0) return a < b ? { d: a, m: 0 } : { d: b, m: 1 };
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  const d = Math.min(a, b) - h * h * k * 0.25;
  const m = a < b ? 0.5 * h * h : 1 - 0.5 * h * h;
  return { d, m };
}

/** 2 つの形がつながる幅 k を、出発点の太さから決める（太い出発点ほど遠くまでつながる） */
export function mergeWidth(anchorThickness: number): number {
  // 細いボタン（24〜28px）でも首が見えるように、太さに下駄を履かせる
  return Math.max(40, Math.min(72, anchorThickness * 1.2 + 16));
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 動きの途中の k。広がりきる前に 0 へ絞り、最後は必ず別々の形にする
 * （行き先が出発点のすぐ隣でも、くっついたまま止まらない）。grown は大きさの広がりの進み具合
 */
export function mergeAt(k: number, grown: number): number {
  return k * (1 - smoothstep(0.45, 0.9, grown));
}

// ---- 粘り: つながっているあいだ（首があるあいだ）は実体を出発点の側へ引き留め、切れたらばねで放す。
// 速い動きでも首が数コマかけて細くなり、くびれて切れるのが見えるようにする

class Spring {
  x = 0;
  v = 0;
  private k: number;
  private c: number;
  constructor(duration: number, bounce: number) {
    this.k = ((2 * Math.PI) / duration) ** 2;
    this.c = (4 * Math.PI * (1 - bounce)) / duration;
  }
  step(target: number, dt: number) {
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** 粘りの強さ: すきまのこの割合だけ引き留める。上限は k × CAP */
const HOLD = 0.6;
const CAP = 0.8;

export class Adhesion {
  /** 首でつながっている */
  connected: boolean;
  /** 引き留める量（px。負なら放されて前へ跳ねている） */
  pull = 0;
  private release = new Spring(0.45, 0.4);
  /** 切れた瞬間に呼ぶ */
  onSnap?: () => void;
  constructor(connected: boolean) {
    this.connected = connected;
  }
  /** raw: 引き留める前のすきま、k: いまのつながる幅 */
  update(dt: number, raw: number, k: number): number {
    if (this.connected) {
      const hold = Math.min(raw * HOLD, k * CAP);
      // 画面上のすきまが k/2 を越えると首が切れる（2 次の smin の性質）
      if (raw - hold >= k / 2 || k <= 0.5) {
        this.connected = false;
        this.release.x = hold;
        this.release.v = 0;
        this.onSnap?.();
      } else {
        this.pull = hold;
        return this.pull;
      }
    }
    this.pull = this.release.step(0, dt);
    return this.pull;
  }
}

/**
 * 出だしが柔らかいばね: 最初は剛性を FROM 倍にして、RAMP 秒かけて本来の剛性へ上げる（減衰は剛性の平方根に合わせる）。
 * つながっているあいだはゆっくり剥がれ、離れてから加速する。終わりの揺れ方は元のばねと同じ
 */
export class PeelSpring {
  x = 0;
  v = 0;
  t = 0;
  private k: number;
  private c: number;
  private from: number;
  private ramp: number;
  constructor(duration: number, bounce: number, from = 0.18, ramp = 0.16) {
    this.k = ((2 * Math.PI) / duration) ** 2;
    this.c = (4 * Math.PI * (1 - bounce)) / duration;
    this.from = from;
    this.ramp = ramp;
  }
  step(target: number, dt: number) {
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.t += h;
      const r = Math.min(1, this.t / this.ramp);
      const s = this.from + (1 - this.from) * r * r * (3 - 2 * r);
      this.v += (-this.k * s * (this.x - target) - this.c * Math.sqrt(s) * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  settled(target: number) {
    return this.t > this.ramp && Math.abs(this.x - target) < 0.001 && Math.abs(this.v) < 0.01;
  }
}
