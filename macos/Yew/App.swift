import AppKit
import WebKit

/// The words of the menus and alerts: Chinese when it is the first language the person chose.
enum Text {
	static let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false

	static func pick(_ zh: String, _ en: String) -> String {
		chinese ? zh : en
	}
}

/// Starts Yew Harness if it is not running and gets a one-time link that signs a window in.
enum Starter {
	/// Runs the script `yew app install` wrote; nil when it could not start Yew Harness.
	static func link() -> URL? {
		guard let script = Bundle.main.url(forResource: "yew-link", withExtension: nil) else {
			return nil
		}
		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/bin/sh")
		process.arguments = [script.path]
		let output = Pipe()
		process.standardOutput = output
		process.standardError = FileHandle.nullDevice
		process.standardInput = FileHandle.nullDevice
		do {
			try process.run()
		} catch {
			return nil
		}
		let data = output.fileHandleForReading.readDataToEndOfFile()
		process.waitUntilExit()
		let lines = String(decoding: data, as: UTF8.self)
			.split(whereSeparator: \.isNewline)
			.map { $0.trimmingCharacters(in: .whitespaces) }
		// The link is the one Yew Harness prints for itself: http://127.0.0.1:<port>/#t=...
		guard process.terminationStatus == 0, let last = lines.last, let url = URL(string: last),
			url.scheme == "http", url.host == "127.0.0.1", url.port != nil
		else { return nil }
		return url
	}
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
	/// The port Yew Harness answers on, from the sign-in link.
	private(set) var port: Int?
	private var main: WebWindow?
	/// Windows a page of Yew Harness opened (a link to another of its pages); kept until closed.
	private var others: [WebWindow] = []
	private var starting = false
	/// When the window last started Yew Harness again by itself, so a failing start is not repeated.
	private var restartedAt: Date?

	func applicationDidFinishLaunching(_ notification: Notification) {
		NSApp.mainMenu = Menus.make(target: self)
		Appearance.restore()
		let window = WebWindow(app: self, configuration: WebWindow.configuration(), primary: true)
		main = window
		window.show()
		connect()
		if #available(macOS 14, *) {
			NSApp.activate()
		} else {
			NSApp.activate(ignoringOtherApps: true)
		}
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
		false
	}

	/// Clicking the Dock icon brings the window back; its page kept running while it was closed.
	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
		if !flag { main?.show() }
		return true
	}

	/// Starts Yew Harness when it is not running, then signs the main window in.
	func connect() {
		guard !starting, let main else { return }
		starting = true
		main.showWaiting()
		Task.detached {
			let link = Starter.link()
			await self.connected(link)
		}
	}

	private func connected(_ link: URL?) {
		starting = false
		guard let link, let main else {
			failed()
			return
		}
		port = link.port
		main.load(link)
	}

	/// The page of Yew Harness could not be reached: it stopped. Start it again, once in a while.
	func lost() {
		if let restartedAt, Date().timeIntervalSince(restartedAt) < 20 {
			failed()
			return
		}
		restartedAt = Date()
		connect()
	}

	private func failed() {
		let alert = NSAlert()
		alert.messageText = Text.pick("Yew Harness 没有启动起来", "Yew Harness did not start")
		alert.informativeText = Text.pick(
			"在终端里运行 yew serve 可以看到原因。",
			"Run yew serve in a terminal to see why."
		)
		alert.addButton(withTitle: Text.pick("重试", "Try Again"))
		alert.addButton(withTitle: Text.pick("退出", "Quit"))
		if alert.runModal() == .alertFirstButtonReturn {
			restartedAt = nil
			connect()
		} else {
			NSApp.terminate(nil)
		}
	}

	/// After an update put a new program into the app (`yew app install` replaces the app), the
	/// page's next load opens the app again from it, so the window is as new as the page.
	func relaunchIfReplaced() {
		let running = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
		let plist = Bundle.main.bundleURL.appendingPathComponent("Contents/Info.plist")
		guard let info = NSDictionary(contentsOf: plist),
			let installed = info["CFBundleVersion"] as? String, installed != running
		else { return }
		let relaunch = Process()
		relaunch.executableURL = URL(fileURLWithPath: "/bin/sh")
		// Opens the app again once this one has quit.
		relaunch.arguments = [
			"-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; /usr/bin/open \"$2\"",
			"yew-relaunch", String(ProcessInfo.processInfo.processIdentifier), Bundle.main.bundlePath,
		]
		do {
			try relaunch.run()
		} catch {
			return
		}
		NSApp.terminate(nil)
	}

	/// Whether an address is one of Yew Harness's own pages: its host and port.
	func isYew(_ url: URL) -> Bool {
		guard let port else { return false }
		return url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost")
			&& url.port == port
	}

	/// A window for a page of Yew Harness that a page opened, sharing the main window's sign-in.
	func open(configuration: WKWebViewConfiguration) -> WKWebView {
		let window = WebWindow(app: self, configuration: configuration, primary: false)
		others.append(window)
		window.show()
		return window.webView
	}

	func closed(_ window: WebWindow) {
		others.removeAll { $0 === window }
	}

	/// The Dock icon shows how many things wait in the approval center, as the page's title does.
	func titleChanged(_ title: String) {
		let count = title.hasPrefix("(") ? String(title.dropFirst().prefix { $0.isNumber }) : ""
		NSApp.dockTile.badgeLabel = count.isEmpty ? nil : count
	}

	/// The window the menu acts on: the one in front, else the main one.
	private var current: WebWindow? {
		others.first { $0.window.isKeyWindow } ?? main
	}

	@objc func showAbout(_ sender: Any?) {
		main?.show()
		// The page opens its own About, in the settings.
		main?.run("window.dispatchEvent(new CustomEvent('yew-app', { detail: 'about' }))")
	}

	@objc func showSettings(_ sender: Any?) {
		main?.show()
		// The same as pressing Command-comma in the page.
		main?.run(
			"document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }))"
		)
	}

	@objc func reloadPage(_ sender: Any?) {
		current?.webView.reload()
	}

	@objc func zoomIn(_ sender: Any?) {
		current?.zoom(by: 0.1)
	}

	@objc func zoomOut(_ sender: Any?) {
		current?.zoom(by: -0.1)
	}

	@objc func actualSize(_ sender: Any?) {
		current?.webView.pageZoom = 1
	}
}
