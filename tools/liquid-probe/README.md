# liquid-probe

Apple の Liquid Glass の動きを数値で測る道具。

- `Probe.swift`: 本物の SwiftUI の Liquid Glass（glassEffect / glassEffectID / GlassEffectContainer）で変形を起こし、
  毎フレーム、ウィンドウ内の全レイヤーの presentation の値（位置・大きさ・角の丸み・アニメーション・SDF 系の非公開プロパティ）を JSON Lines で書き出す
- `fit.py`: 記録した軌跡に SwiftUI のばね（duration, bounce）と開始時刻を当てはめる（numpy なし）

```sh
swiftc -O -parse-as-library -target arm64-apple-macos26.0 Probe.swift -o probe
./probe morph default out.jsonl          # morph | separate | press、default | smooth | snappy | bouncy
python3 fit.py out.jsonl 0.1.0 r 0.1 1.7  # SwiftUI 側のコンテナ（0.1.0）の右端
```

## 分かったこと（2026-11-16、macOS 26.6.2）

- ガラスの形は `CASDFLayer` / `CASDFElementLayer` で描かれる。形の値は描画プロセス側で補間され、レイヤーの presentation には途中の値が出ない
- SwiftUI 側のコンテナ（`SDFLayer`）の大きさは毎フレーム変わり、形の右端・下端の軌跡になる
- `withAnimation(.default)` の glassEffectID の変形: 右端も下端も **同じ瞬間に同じ曲線**（duration 0.50 秒、bounce 0、誤差 0.4% 以内）。
  端ごとに遅れる動きではない。液体らしさは形の合成（SDF）の描き方による

## 液体の融合のコマ送り

分離アニメーションの「つながり」は、Liquid Glass と同じく距離場（SDF）の滑らかな最小値（iq の 2 次の smin）で作る
（`apps/desktop/src/components/liquid/sdf.ts`、GPU は `liquid-gl.ts`）。確かめ方は 2 つ。

- `sdf-film.mjs`: sdf.ts の式を CPU で 1 画素ずつ塗り、ばねを進めたコマを並べた PNG にする（ブラウザ不要）
  ```sh
  node tools/liquid-probe/sdf-film.mjs "$PWD/apps/desktop/src/components/liquid/sdf.ts" row /tmp/row.png zoom   # row | far | chip、zoom は 1/60 秒ごと等倍
  ```
- `app-frames.sh`: 本物のアプリ（dev サーバー）をヘッドレスの Chrome で開き、仮想時間を 1/60 秒ずつ進めて撮る。
  GPU の描画（シェーダー）・重なり順・本物のボタンとの関係まで確かめられる。アプリの時計は performance.now に揃えてある
  （requestAnimationFrame の引数は実時間で進むことがあるので使わない）

調べたこと（2026-11）:
- GlassEffectContainer の spacing: すきまが spacing の約半分以下でつながり、それより広いと縁が互いへ寄るだけ
  （[sarunw](https://sarunw.com/posts/swiftui-glasseffectcontainer/) の実測）。2 次の smin で k = spacing とすると、真ん中の距離が
  gap/2 − k/4 ≤ 0、つまり gap ≤ k/2 でつながるので一致する
- [Fizzy の液体ガラス](https://github.com/fizzyedit/fizzy/pull/197): 角丸の箱の距離場を iq の 2 次の smin で 1 つにし、混ざり具合で
  2 つの材質を混ぜる。縁は 1px の傾きで滑らかに。ふくらみは最大 k/4
