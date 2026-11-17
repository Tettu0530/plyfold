# liquid-probe

Tools for measuring the motion of Apple's Liquid Glass numerically.

- `Probe.swift`: triggers morphs with the real SwiftUI Liquid Glass (glassEffect / glassEffectID / GlassEffectContainer) and,
  every frame, writes the presentation values of every layer in the window (position, size, corner radius, animations, private SDF properties) as JSON Lines
- `fit.py`: fits a SwiftUI spring (duration, bounce) and a start time to a recorded trajectory (no numpy)

```sh
swiftc -O -parse-as-library -target arm64-apple-macos26.0 Probe.swift -o probe
./probe morph default out.jsonl          # morph | separate | press, default | smooth | snappy | bouncy
python3 fit.py out.jsonl 0.1.0 r 0.1 1.7  # right edge of the SwiftUI-side container (0.1.0)
```

## Findings (2026-11-16, macOS 26.6.2)

- Glass shapes are drawn by `CASDFLayer` / `CASDFElementLayer`. Shape values are interpolated in the render server, so intermediate values never show up in the layers' presentation
- The size of the SwiftUI-side container (`SDFLayer`) changes every frame and traces the right and bottom edges of the shape
- A glassEffectID morph under `withAnimation(.default)`: the right and bottom edges follow **the same curve at the same moment** (duration 0.50 s, bounce 0, within 0.4% error).
  It is not a motion where each edge lags. The liquid feel comes from how the shapes are combined (SDF)

## Frame-by-frame liquid merging

The "bridge" in the separation animation is built, like Liquid Glass, from a smooth minimum of distance fields (SDF) (iq's quadratic smin)
(`apps/desktop/src/components/liquid/sdf.ts`, `liquid-gl.ts` on the GPU). There are two ways to check it.

- `sdf-film.mjs`: rasterizes the sdf.ts formula pixel by pixel on the CPU and lays out frames of the advancing spring as a PNG (no browser needed)
  ```sh
  node tools/liquid-probe/sdf-film.mjs "$PWD/apps/desktop/src/components/liquid/sdf.ts" row /tmp/row.png zoom   # row | far | chip; zoom = 1:1 frames every 1/60 s
  ```
- `app-frames.sh`: opens the real app (dev server) in headless Chrome and captures it while advancing virtual time 1/60 s at a time.
  This covers GPU rendering (shaders), stacking order and how it lines up with the real buttons. The app's clock is aligned to performance.now
  (the requestAnimationFrame argument can advance in real time, so it is not used)

Research (2026-11):
- GlassEffectContainer spacing: shapes connect when the gap is about half the spacing or less; with a wider gap their edges only lean toward each other
  (measured by [sarunw](https://sarunw.com/posts/swiftui-glasseffectcontainer/)). With a quadratic smin and k = spacing, the distance at the midpoint is
  gap/2 − k/4 ≤ 0, i.e. they connect when gap ≤ k/2, which matches
- [Fizzy's liquid glass](https://github.com/fizzyedit/fizzy/pull/197): combines rounded-box distance fields into one with iq's quadratic smin and uses the blend factor to
  mix two materials. Edges are smoothed with a 1px slope. The bulge is at most k/4
