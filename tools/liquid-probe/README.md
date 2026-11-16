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
