"""プローブの記録（JSON Lines）から、ある値の軌跡を取り出し、SwiftUI のばね（duration, bounce）と遅れを当てはめる。
numpy を使わず、格子探索 → 細かい格子探索で最小二乗を解く。

    python3 fit.py <record.jsonl> <layer-path> <field: x|y|w|h|r|b> [t0 t1]
"""
import json, math, sys

def spring_pos(d, b, t):
    if t <= 0: return 0.0
    k = (2 * math.pi / d) ** 2
    c = 4 * math.pi * (1 - b) / d if b >= 0 else 4 * math.pi / (d * (1 + b))
    w0 = math.sqrt(k); z = c / (2 * w0)
    if z < 1:
        wd = w0 * math.sqrt(1 - z * z)
        return 1 - math.exp(-z * w0 * t) * (math.cos(wd * t) + z * w0 / wd * math.sin(wd * t))
    if abs(z - 1) < 1e-9: return 1 - math.exp(-w0 * t) * (1 + w0 * t)
    r1 = -w0 * (z - math.sqrt(z * z - 1)); r2 = -w0 * (z + math.sqrt(z * z - 1))
    return 1 - (r2 * math.exp(r1 * t) - r1 * math.exp(r2 * t)) / (r2 - r1)

def series(path, layer, field, t0, t1):
    out = []
    for line in open(path):
        f = json.loads(line)
        if not (t0 <= f['t'] <= t1): continue
        L = next(x for x in f['layers'] if x['path'] == layer)
        v = {'x': L['x'], 'y': L['y'], 'w': L['w'], 'h': L['h'], 'r': L['x'] + L['w'], 'b': L['y'] + L['h']}[field]
        out.append((f['t'], v))
    return out

def fit(pts):
    v0, v1 = pts[0][1], pts[-1][1]
    span = v1 - v0
    if abs(span) < 1e-6: return None
    norm = [(t, (v - v0) / span) for t, v in pts]
    # 動き始めの時刻（最初に 0.5% 動いたフレームの 1 つ前）を起点の目安にする
    start = next(t for t, y in norm if abs(y) > 0.005)
    def err(d, b, lag):
        return sum((spring_pos(d, b, t - lag) - y) ** 2 for t, y in norm)
    best = None
    for d in [x / 100 for x in range(15, 121, 1)]:
        for b in [x / 100 for x in range(-40, 81, 2)]:
            for lag in [start - 0.034 + i * 0.004 for i in range(0, 18)]:
                e = err(d, b, lag)
                if best is None or e < best[0]: best = (e, d, b, lag)
    e, d, b, lag = best
    for dd in [d + i / 1000 for i in range(-10, 11)]:
        for bb in [b + i / 500 for i in range(-10, 11)]:
            for ll in [lag + i / 1000 for i in range(-4, 5)]:
                ee = err(dd, bb, ll)
                if ee < best[0]: best = (ee, dd, bb, ll)
    e, d, b, lag = best
    rms = math.sqrt(e / len(norm))
    peak = max(y for _, y in norm)
    return {'from': round(v0, 1), 'to': round(v1, 1), 'duration': round(d, 3), 'bounce': round(b, 3), 'start': round(lag, 3), 'rms': round(rms, 4), 'overshoot%': round((peak - 1) * 100, 2), 'frames': len(norm)}

if __name__ == '__main__':
    path, layer, field = sys.argv[1:4]
    t0 = float(sys.argv[4]) if len(sys.argv) > 4 else 0
    t1 = float(sys.argv[5]) if len(sys.argv) > 5 else 99
    print(fit(series(path, layer, field, t0, t1)))
