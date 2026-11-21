// Draws Yew's app icons from its mark (web/public/icons/yew-mark.svg, viewBox 64): a yew berry, red
// with its dark green seed, and one leaf, dark green on light and pale on dark. Run from the repository
// root when the mark changes:
//   swift scripts/icons.swift
// It writes the launcher app's icon for macOS (a white rounded plate with the margins macOS icons
// keep), the iPhone app's icon, light and dark (full square, no transparency, as Apple asks), and the
// web page's home-screen icon, which is the light iPhone icon at 180 px (the product's own graphic,
// no Tenon badge).
import AppKit

let red = CGColor(srgbRed: 0xC8 / 255, green: 0x32 / 255, blue: 0x3F / 255, alpha: 1)
let green = CGColor(srgbRed: 0x1F / 255, green: 0x3A / 255, blue: 0x2E / 255, alpha: 1)
let pale = CGColor(srgbRed: 0xE3 / 255, green: 0xE8 / 255, blue: 0xE4 / 255, alpha: 1)

/// The mark in its own 64 by 64 space, origin at the top left as in the SVG.
func drawMark(_ context: CGContext, leaf: CGColor) {
	let path = CGMutablePath()
	path.move(to: CGPoint(x: 35.4, y: 50.2))
	path.addCurve(to: CGPoint(x: 60, y: 12.6), control1: CGPoint(x: 36.6, y: 37.6), control2: CGPoint(x: 42.6, y: 22.6))
	path.addCurve(to: CGPoint(x: 49.4, y: 38.6), control1: CGPoint(x: 58.6, y: 24.4), control2: CGPoint(x: 55.2, y: 32.4))
	path.addCurve(to: CGPoint(x: 35.4, y: 50.2), control1: CGPoint(x: 45, y: 43.3), control2: CGPoint(x: 39.4, y: 46.4))
	path.closeSubpath()
	context.setFillColor(leaf)
	context.addPath(path)
	context.fillPath()
	context.setFillColor(red)
	context.fillEllipse(in: CGRect(x: 19.8 - 15.9, y: 35.4 - 15.4, width: 31.8, height: 30.8))
	context.saveGState()
	context.translateBy(x: 25.8, y: 22.6)
	context.rotate(by: 12 * .pi / 180)
	context.setFillColor(green)
	context.fillEllipse(in: CGRect(x: -4.6, y: -3.1, width: 9.2, height: 6.2))
	context.restoreGState()
}

/// The mark's drawn extent in its 64 space, so it can be centred by what is drawn.
let extent = CGRect(x: 3.9, y: 12.6, width: 56.1, height: 38.2)

func canvas(_ size: Int) -> CGContext {
	let context = CGContext(
		data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
		space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
	context.translateBy(x: 0, y: CGFloat(size))
	context.scaleBy(x: 1, y: -1)
	return context
}

func placeMark(_ context: CGContext, size: CGFloat, width: CGFloat, leaf: CGColor) {
	let scale = width / extent.width
	context.saveGState()
	context.translateBy(
		x: (size - extent.width * scale) / 2 - extent.minX * scale,
		y: (size - extent.height * scale) / 2 - extent.minY * scale)
	context.scaleBy(x: scale, y: scale)
	drawMark(context, leaf: leaf)
	context.restoreGState()
}

func write(_ context: CGContext, _ path: String, opaque: Bool) throws {
	var image = context.makeImage()!
	if opaque {
		// The App Store refuses icons with an alpha channel.
		let flat = CGContext(
			data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
			space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
		flat.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
		image = flat.makeImage()!
	}
	let rep = NSBitmapImageRep(cgImage: image)
	try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
	print("wrote \(path)")
}

// macOS launcher: the plate is 824 of 1024, as Apple's icon grid has it, with a soft shadow and a
// hairline edge so it reads on a light Dock.
do {
	let context = canvas(1024)
	let plate = CGRect(x: 100, y: 100, width: 824, height: 824)
	let shape = CGPath(roundedRect: plate, cornerWidth: 185, cornerHeight: 185, transform: nil)
	context.saveGState()
	context.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: CGColor(gray: 0, alpha: 0.28))
	context.setFillColor(CGColor(gray: 1, alpha: 1))
	context.addPath(shape)
	context.fillPath()
	context.restoreGState()
	context.setStrokeColor(CGColor(gray: 0, alpha: 0.1))
	context.setLineWidth(2)
	context.addPath(shape)
	context.strokePath()
	placeMark(context, size: 1024, width: 540, leaf: green)
	try write(context, "web/public/icons/app-icon.png", opaque: false)
}

// iPhone: light and dark, the whole square filled.
for (name, background, leaf) in [
	("AppIcon.png", CGColor(gray: 1, alpha: 1), green),
	("AppIcon-Dark.png", CGColor(srgbRed: 0.07, green: 0.07, blue: 0.07, alpha: 1), pale),
] {
	let context = canvas(1024)
	context.setFillColor(background)
	context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
	placeMark(context, size: 1024, width: 660, leaf: leaf)
	try write(context, "ios/Yew/Assets.xcassets/AppIcon.appiconset/\(name)", opaque: true)
}

// The web page's home-screen icon (apple-touch-icon): the light iPhone icon at 180 by 180.
do {
	let context = canvas(180)
	context.setFillColor(CGColor(gray: 1, alpha: 1))
	context.fill(CGRect(x: 0, y: 0, width: 180, height: 180))
	placeMark(context, size: 180, width: 180 * 660 / 1024, leaf: green)
	try write(context, "web/public/icons/apple-touch-icon.png", opaque: true)
}
