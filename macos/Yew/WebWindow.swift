import AppKit
import WebKit

/// One window showing Yew Harness's page. Only Yew Harness's own pages load in it: any other
/// address, such as a link in a message or a sign-in at an MCP server, opens in the person's browser.
@MainActor
final class WebWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
	WKDownloadDelegate
{
	/// The main window's web view: the cookie Yew Harness signs it in with is kept on disk.
	static func configuration() -> WKWebViewConfiguration {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .default()
		let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
		configuration.applicationNameForUserAgent = "YewHarness/\(version ?? "0")"
		return configuration
	}

	let window: NSWindow
	let webView: WKWebView
	private unowned let app: AppDelegate
	private let primary: Bool
	private let waiting = NSStackView()
	private var titleWatch: NSKeyValueObservation?
	private var themeWatch: NSKeyValueObservation?
	/// The page has loaded; until then a `theme-color` that is not there yet means nothing.
	private var loaded = false
	/// The last address handed to the person's browser, so a redirect seen twice opens it once.
	private var handedOut: URL?
	/// Where each download in progress is being saved, to mark the file when it is done.
	private var saving: [ObjectIdentifier: URL] = [:]

	init(app: AppDelegate, configuration: WKWebViewConfiguration, primary: Bool) {
		self.app = app
		self.primary = primary
		webView = WKWebView(frame: .zero, configuration: configuration)
		window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: primary ? 1280 : 960, height: primary ? 820 : 720),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false
		)
		super.init()
		window.title = "Yew Harness"
		window.backgroundColor = Appearance.page
		window.minSize = NSSize(width: 720, height: 480)
		window.isReleasedWhenClosed = false
		window.tabbingMode = .disallowed
		window.delegate = self

		let content = NSView()
		window.contentView = content
		for view in [webView, waiting] as [NSView] {
			view.translatesAutoresizingMaskIntoConstraints = false
			content.addSubview(view)
		}
		NSLayoutConstraint.activate([
			webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
			webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
			webView.topAnchor.constraint(equalTo: content.topAnchor),
			webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
			waiting.centerXAnchor.constraint(equalTo: content.centerXAnchor),
			waiting.centerYAnchor.constraint(equalTo: content.centerYAnchor),
		])
		let spinner = NSProgressIndicator()
		spinner.style = .spinning
		spinner.controlSize = .small
		spinner.startAnimation(nil)
		let label = NSTextField(labelWithString: Text.pick("正在启动 Yew Harness…", "Starting Yew Harness…"))
		label.textColor = .secondaryLabelColor
		waiting.orientation = .vertical
		waiting.spacing = 10
		waiting.addArrangedSubview(spinner)
		waiting.addArrangedSubview(label)
		waiting.isHidden = true
		// Shown once the page has drawn itself: until then a web view is white, which flashes in dark.
		webView.alphaValue = 0

		webView.navigationDelegate = self
		webView.uiDelegate = self
		webView.allowsBackForwardNavigationGestures = false
		webView.underPageBackgroundColor = Appearance.page
		if #available(macOS 13.3, *) {
			webView.isInspectable = ProcessInfo.processInfo.environment["YEW_APP_INSPECT"] == "1"
		}
		titleWatch = webView.observe(\.title, options: [.new]) { [weak self] webView, _ in
			MainActor.assumeIsolated { self?.titleChanged(webView.title ?? "") }
		}
		themeWatch = webView.observe(\.themeColor, options: [.new]) { [weak self] webView, _ in
			MainActor.assumeIsolated { self?.themeChanged(webView.themeColor) }
		}

		if primary {
			window.setFrameAutosaveName("Yew Harness")
			if window.frame.origin == .zero { window.center() }
		} else {
			window.center()
		}
	}

	func show() {
		window.makeKeyAndOrderFront(nil)
	}

	/// While Yew Harness starts, before its page has loaded: the window in the page's color, and a
	/// spinner once it takes a moment (a start that takes no time shows none).
	func showWaiting() {
		guard webView.url == nil else { return }
		Task { [weak self] in
			try? await Task.sleep(for: .milliseconds(800))
			guard let self, self.webView.alphaValue < 1 else { return }
			self.waiting.isHidden = false
		}
	}

	/// Shows the page once it has drawn a frame. A second is the most it waits.
	private func reveal() {
		guard webView.alphaValue < 1 else { return }
		Task { [weak self] in
			// When the second frame is asked for, the first has been drawn.
			_ = try? await self?.webView.callAsyncJavaScript(
				"await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))",
				contentWorld: .defaultClient
			)
			self?.showPage()
		}
		Task { [weak self] in
			try? await Task.sleep(for: .seconds(1))
			self?.showPage()
		}
	}

	private func showPage() {
		waiting.isHidden = true
		webView.alphaValue = 1
	}

	func load(_ url: URL) {
		webView.load(URLRequest(url: url))
	}

	func run(_ script: String) {
		webView.evaluateJavaScript(script, completionHandler: nil)
	}

	func zoom(by step: CGFloat) {
		webView.pageZoom = min(3, max(0.5, webView.pageZoom + step))
	}

	/// The main window's page chose light or dark, or went back to the system's.
	private func themeChanged(_ color: NSColor?) {
		if primary, loaded { Appearance.follow(color) }
	}

	private func titleChanged(_ title: String) {
		if primary {
			app.titleChanged(title)
		} else {
			window.title = title.isEmpty ? "Yew Harness" : title
		}
	}

	/// Opens an address in the person's default browser; only web and mail addresses.
	private func handOut(_ url: URL) {
		guard handedOut != url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "")
		else { return }
		handedOut = url
		NSWorkspace.shared.open(url)
	}

	/// A blob: address of one of Yew Harness's pages, such as a file the page made to save.
	private func isYewBlob(_ url: URL) -> Bool {
		guard url.scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst(5)))
		else { return false }
		return app.isYew(inner)
	}

	// MARK: Navigation

	func webView(
		_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
	) {
		guard let url = navigationAction.request.url else {
			decisionHandler(.cancel)
			return
		}
		let ours = app.isYew(url) || isYewBlob(url)
		// Only Yew Harness's own files are saved from the window; any other download link goes to the
		// person's browser (a security requirement).
		if navigationAction.shouldPerformDownload {
			if ours {
				decisionHandler(.download)
			} else {
				decisionHandler(.cancel)
				handOut(url)
			}
			return
		}
		// Frames inside a page follow the page's own rules, as in a browser.
		guard navigationAction.targetFrame?.isMainFrame ?? true else {
			decisionHandler(.allow)
			return
		}
		if ours || url.absoluteString == "about:blank" {
			decisionHandler(.allow)
			return
		}
		decisionHandler(.cancel)
		handOut(url)
		// A window that only led elsewhere has nothing to show.
		if !primary, webView.url == nil || webView.url?.absoluteString == "about:blank" {
			window.close()
		}
	}

	func webView(
		_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
		decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
	) {
		if navigationResponse.canShowMIMEType {
			decisionHandler(.allow)
		} else if let url = navigationResponse.response.url, app.isYew(url) || isYewBlob(url) {
			decisionHandler(.download)
		} else {
			// Something a frame from elsewhere would make the window save: not from this window.
			decisionHandler(.cancel)
		}
	}

	/// A page of Yew Harness sent the window elsewhere, such as to an MCP server's sign-in:
	/// that goes to the person's browser, which comes back to Yew Harness by itself.
	func webView(
		_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!
	) {
		guard let url = webView.url, !app.isYew(url) else { return }
		webView.stopLoading()
		handOut(url)
		if !primary { window.close() }
	}

	func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
		loaded = false
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		loaded = true
		themeChanged(webView.themeColor)
		reveal()
		if primary { app.relaunchIfReplaced() }
	}

	func webView(
		_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
		withError error: any Error
	) {
		failed(error)
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
		failed(error)
	}

	private func failed(_ error: any Error) {
		let error = error as NSError
		// Not reached at all: Yew Harness stopped, so it is started again.
		let unreachable = [
			NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
			NSURLErrorCannotFindHost,
		]
		if primary, error.domain == NSURLErrorDomain, unreachable.contains(error.code) {
			app.lost()
		}
	}

	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		webView.reload()
	}

	func webView(
		_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
	) {
		download.delegate = self
	}

	func webView(
		_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload
	) {
		download.delegate = self
	}

	// MARK: Windows and dialogs a page asks for

	func webView(
		_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
		for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
	) -> WKWebView? {
		if let url = navigationAction.request.url, url.absoluteString != "about:blank",
			url.absoluteString != "", !app.isYew(url)
		{
			handOut(url)
			return nil
		}
		return app.open(configuration: configuration)
	}

	func webViewDidClose(_ webView: WKWebView) {
		if !primary { window.close() }
	}

	func webView(
		_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
		initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void
	) {
		let alert = NSAlert()
		alert.messageText = message
		alert.beginSheetModal(for: window) { _ in completionHandler() }
	}

	func webView(
		_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
		initiatedByFrame frame: WKFrameInfo,
		completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
	) {
		let alert = NSAlert()
		alert.messageText = message
		alert.addButton(withTitle: Text.pick("好", "OK"))
		alert.addButton(withTitle: Text.pick("取消", "Cancel"))
		alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
	}

	// MARK: Saving files

	/// A file the page saves, such as a session exported as Markdown: the person picks where.
	func download(
		_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
		completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
	) {
		let panel = NSSavePanel()
		panel.nameFieldStringValue = suggestedFilename
		panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)
			.first
		panel.beginSheetModal(for: window) { response in
			guard response == .OK, let url = panel.url else {
				completionHandler(nil)
				return
			}
			// The save panel asked before replacing a file; a download does not write over one.
			try? FileManager.default.removeItem(at: url)
			self.saving[ObjectIdentifier(download)] = url
			completionHandler(url)
		}
	}

	/// A saved file is marked as downloaded, so macOS checks it before it is opened: what a session
	/// made could be anything.
	func downloadDidFinish(_ download: WKDownload) {
		guard let file = saving.removeValue(forKey: ObjectIdentifier(download)) else { return }
		Quarantine.mark(file, from: download.originalRequest?.url)
	}

	func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
		saving.removeValue(forKey: ObjectIdentifier(download))
		NSSound.beep()
	}

	// MARK: The window

	func windowWillClose(_ notification: Notification) {
		if !primary { app.closed(self) }
	}
}
