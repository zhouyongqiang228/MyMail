import AppKit

let destination = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("assets")
let iconset = destination.appendingPathComponent("MyMail.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func line(_ points: [NSPoint], color: NSColor, width: CGFloat) {
    let path = NSBezierPath()
    path.move(to: points[0])
    for point in points.dropFirst() { path.line(to: point) }
    path.lineWidth = width
    path.lineJoinStyle = .round
    path.lineCapStyle = .round
    color.setStroke()
    path.stroke()
}

func render(size: Int, tray: Bool = false) -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(size) / 1024)
    transform.concat()
    if tray {
        NSColor.black.setStroke()
        let envelope = NSBezierPath(roundedRect: NSRect(x: 84, y: 205, width: 856, height: 614), xRadius: 100, yRadius: 100)
        envelope.lineWidth = 72
        envelope.stroke()
        line([NSPoint(x: 115, y: 745), NSPoint(x: 512, y: 442), NSPoint(x: 909, y: 745)], color: .black, width: 72)
    } else {
        let tile = NSBezierPath(roundedRect: NSRect(x: 88, y: 88, width: 848, height: 848), xRadius: 192, yRadius: 192)
        let dark = NSColor(srgbRed: 0.045, green: 0.39, blue: 0.38, alpha: 1)
        let light = NSColor(srgbRed: 0.12, green: 0.62, blue: 0.52, alpha: 1)
        NSGradient(starting: dark, ending: light)!.draw(in: tile, angle: 75)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
        shadow.shadowBlurRadius = 22
        shadow.shadowOffset = NSSize(width: 0, height: -12)
        shadow.set()
        NSColor(srgbRed: 0.98, green: 0.99, blue: 0.99, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 230, y: 312, width: 564, height: 408), xRadius: 52, yRadius: 52).fill()
        NSGraphicsContext.restoreGraphicsState()
        let fold = NSColor(srgbRed: 0.68, green: 0.84, blue: 0.79, alpha: 1)
        line([NSPoint(x: 246, y: 334), NSPoint(x: 431, y: 500)], color: fold, width: 15)
        line([NSPoint(x: 778, y: 334), NSPoint(x: 593, y: 500)], color: fold, width: 15)
        line([NSPoint(x: 250, y: 679), NSPoint(x: 512, y: 485), NSPoint(x: 774, y: 679)], color: dark, width: 21)
        NSColor(srgbRed: 0.91, green: 0.99, blue: 0.67, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 712, y: 652, width: 136, height: 136)).fill()
        light.setStroke()
        let badge = NSBezierPath(ovalIn: NSRect(x: 712, y: 652, width: 136, height: 136))
        badge.lineWidth = 13
        badge.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try render(size: size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size: size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
try render(size: 1024).write(to: destination.appendingPathComponent("icon.png"))
try render(size: 22, tray: true).write(to: destination.appendingPathComponent("trayTemplate.png"))
try render(size: 44, tray: true).write(to: destination.appendingPathComponent("trayTemplate@2x.png"))
let conversion = Process()
conversion.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
conversion.arguments = ["-c", "icns", iconset.path, "-o", destination.appendingPathComponent("MyMail.icns").path]
try conversion.run()
conversion.waitUntilExit()
guard conversion.terminationStatus == 0 else { exit(conversion.terminationStatus) }
try FileManager.default.removeItem(at: iconset)
print("Created assets/MyMail.icns, icon.png and menu bar template icons")
