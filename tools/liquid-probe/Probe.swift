// Measures Liquid Glass motion numerically.
// Triggers a morph with real SwiftUI Liquid Glass and, every frame, writes the position, size and corner
// radius of every layer's presentation (the in-flight on-screen values) in the window as JSON Lines.
//
//   swiftc -O -parse-as-library -target arm64-apple-macos26.0 Probe.swift -o probe
//   ./probe <scenario> <animation> <out.jsonl>
//     scenario : morph | separate | press
//     animation: default | smooth | snappy | bouncy
import AppKit
import QuartzCore
import SwiftUI

// MARK: - Scenes

final class Trigger: ObservableObject {
    @Published var on = false
}

struct MorphScene: View {
    @ObservedObject var trigger: Trigger
    @Namespace var ns
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(white: 0.55)
            GlassEffectContainer {
                if trigger.on {
                    Color.clear
                        .frame(width: 360, height: 240)
                        .glassEffect(.regular, in: .rect(cornerRadius: 16))
                        .glassEffectID("surface", in: ns)
                        .padding(.leading, 200).padding(.top, 140)
                } else {
                    Color.clear
                        .frame(width: 160, height: 28)
                        .glassEffect(.regular, in: .capsule)
                        .glassEffectID("surface", in: ns)
                        .padding(.leading, 24).padding(.top, 24)
                }
            }
        }
    }
}

struct SeparateScene: View {
    @ObservedObject var trigger: Trigger
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(white: 0.55)
            GlassEffectContainer(spacing: 40) {
                HStack(spacing: trigger.on ? 220 : 0) {
                    Color.clear.frame(width: 80, height: 80).glassEffect(.regular, in: .circle)
                    Color.clear.frame(width: 80, height: 80).glassEffect(.regular, in: .circle)
                }
                .padding(.leading, 80).padding(.top, 160)
            }
        }
    }
}

struct PressScene: View {
    @ObservedObject var trigger: Trigger
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(white: 0.55)
            Button("Search") {}
                .buttonStyle(.glass)
                .controlSize(.large)
                .padding(.leading, 200).padding(.top, 200)
        }
    }
}

// MARK: - Recording

struct LayerSample: Encodable {
    let path: String
    let cls: String
    let x: Double, y: Double, w: Double, h: Double
    let radius: Double
    let sx: Double, sy: Double
    let opacity: Double
    let anims: [AnimInfo]
    let props: [String: String]
}

/// Reads every ObjC property of SDF-related layers (to find private shape values)
func sdfProps(_ layer: CALayer) -> [String: String] {
    let name = String(describing: type(of: layer))
    guard name.contains("SDF") else { return [:] }
    var out: [String: String] = [:]
    var cls: AnyClass? = type(of: layer)
    while let c = cls, c != CALayer.self {
        var n: UInt32 = 0
        if let list = class_copyPropertyList(c, &n) {
            for i in 0..<Int(n) {
                let key = String(cString: property_getName(list[i]))
                if let v = layer.value(forKey: key) {
                    let s = String(describing: v)
                    out[key] = s.count > 200 ? String(s.prefix(200)) : s
                }
            }
            free(list)
        }
        cls = class_getSuperclass(c)
    }
    return out
}

struct AnimInfo: Encodable {
    let key: String
    let type: String
    let keyPath: String?
    let duration: Double
    let beginTime: Double
    let mass: Double?
    let stiffness: Double?
    let damping: Double?
    let initialVelocity: Double?
    let settling: Double?
    let timing: String?
    let from: String?
    let to: String?
    let additive: Bool
}

func describe(_ v: Any?) -> String? {
    guard let v else { return nil }
    let s = String(describing: v)
    return s.count > 300 ? String(s.prefix(300)) : s
}

func animInfos(_ layer: CALayer) -> [AnimInfo] {
    (layer.animationKeys() ?? []).compactMap { key in
        guard let a = layer.animation(forKey: key) else { return nil }
        let prop = a as? CAPropertyAnimation
        let basic = a as? CABasicAnimation
        let spring = a as? CASpringAnimation
        var timing: String? = nil
        if let tf = a.timingFunction {
            var c1: [Float] = [0, 0], c2: [Float] = [0, 0]
            tf.getControlPoint(at: 1, values: &c1)
            tf.getControlPoint(at: 2, values: &c2)
            timing = "\(c1[0]),\(c1[1]),\(c2[0]),\(c2[1])"
        }
        return AnimInfo(
            key: key, type: String(describing: type(of: a)), keyPath: prop?.keyPath,
            duration: a.duration, beginTime: a.beginTime,
            mass: spring.map { Double($0.mass) }, stiffness: spring.map { Double($0.stiffness) },
            damping: spring.map { Double($0.damping) }, initialVelocity: spring.map { Double($0.initialVelocity) },
            settling: spring.map { $0.settlingDuration }, timing: timing,
            from: describe(basic?.fromValue), to: describe(basic?.toValue), additive: prop?.isAdditive ?? false)
    }
}

struct Frame: Encodable {
    let t: Double
    let layers: [LayerSample]
}

final class Recorder: NSObject {
    let window: NSWindow
    let out: FileHandle
    var start: CFTimeInterval = 0
    var link: CADisplayLink?
    let enc = JSONEncoder()

    init(window: NSWindow, path: String) {
        self.window = window
        FileManager.default.createFile(atPath: path, contents: nil)
        self.out = FileHandle(forWritingAtPath: path)!
    }

    func begin() {
        start = CACurrentMediaTime()
        link = window.contentView!.displayLink(target: self, selector: #selector(tick))
        link?.add(to: .main, forMode: .common)
    }

    @objc func tick() {
        guard let root = window.contentView?.layer else { return }
        var samples: [LayerSample] = []
        walk(root, path: "0", into: &samples, rootLayer: root)
        let f = Frame(t: CACurrentMediaTime() - start, layers: samples)
        if let d = try? enc.encode(f) {
            out.write(d)
            out.write("\n".data(using: .utf8)!)
        }
    }

    func walk(_ layer: CALayer, path: String, into: inout [LayerSample], rootLayer: CALayer) {
        let p = layer.presentation() ?? layer
        // bounding rect in screen (root) coordinates
        let r = rootLayer.convert(p.bounds, from: p)
        let t = p.transform
        into.append(LayerSample(
            path: path, cls: String(describing: type(of: layer)),
            x: r.minX, y: r.minY, w: r.width, h: r.height,
            radius: p.cornerRadius, sx: t.m11, sy: t.m22, opacity: Double(p.opacity), anims: animInfos(layer), props: sdfProps(p)))
        for (i, s) in (layer.sublayers ?? []).enumerated() {
            walk(s, path: "\(path).\(i)", into: &into, rootLayer: rootLayer)
        }
    }
}

// MARK: - Launch

@main
struct ProbeMain {
    static func main() {
        let args = CommandLine.arguments
        let scenario = args.count > 1 ? args[1] : "morph"
        let animName = args.count > 2 ? args[2] : "default"
        let outPath = args.count > 3 ? args[3] : "/tmp/probe.jsonl"

        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let trigger = Trigger()
        let content: AnyView
        switch scenario {
        case "separate": content = AnyView(SeparateScene(trigger: trigger))
        case "press": content = AnyView(PressScene(trigger: trigger))
        default: content = AnyView(MorphScene(trigger: trigger))
        }
        let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 640, height: 460), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "liquid-probe \(scenario) \(animName)"
        window.contentView = NSHostingView(rootView: content.frame(width: 640, height: 460))
        window.contentView?.wantsLayer = true
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)

        let rec = Recorder(window: window, path: outPath)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            rec.begin()
            // record briefly, then trigger the morph (t ≈ 0.2 s)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                let anim: Animation? = switch animName {
                case "smooth": .smooth
                case "snappy": .snappy
                case "bouncy": .bouncy
                default: .default
                }
                withAnimation(anim) { trigger.on.toggle() }
            }
            // open, wait a moment, close
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
                withAnimation(animName == "default" ? .default : nil) { trigger.on.toggle() }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.4) { app.terminate(nil) }
        }
        app.run()
    }
}
