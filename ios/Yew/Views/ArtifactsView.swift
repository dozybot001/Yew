import Charts
import SwiftUI
import WebKit

/// What sessions saved for you to look at: documents, pages, data and charts, newest first.
struct ArtifactsView: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		NavigationStack {
			List(model.artifacts) { artifact in
				NavigationLink {
					ArtifactView(artifact: artifact)
				} label: {
					VStack(alignment: .leading, spacing: 3) {
						Text(artifact.name)
							.lineLimit(2)
						Text(ArtifactKind.line(artifact, session: model.name(of: artifact.sessionId)))
							.font(.footnote)
							.foregroundStyle(.secondary)
					}
				}
			}
			.overlay {
				if model.loaded, model.artifacts.isEmpty {
					ContentUnavailableView("No artifacts yet", systemImage: "doc.text")
				}
			}
			.navigationTitle("Artifacts")
			.refreshable { await model.refreshArtifacts() }
			.yewChrome()
		}
	}
}

enum ArtifactKind {
	static func name(_ kind: String) -> String {
		switch kind {
		case "html": String(localized: "Page")
		case "json": String(localized: "Data")
		case "chart": String(localized: "Chart")
		default: String(localized: "Document")
		}
	}

	static func line(_ artifact: ArtifactItem, session: String) -> String {
		var parts = [name(artifact.kind)]
		if !session.isEmpty { parts.append(session) }
		if artifact.version > 1 { parts.append(String(localized: "Version \(artifact.version)")) }
		return parts.joined(separator: " · ")
	}
}

/// One artifact's latest version, drawn by its kind.
struct ArtifactView: View {
	@Environment(AppModel.self) private var model
	let artifact: ArtifactItem
	@State private var content: String?
	@State private var failed = false

	var body: some View {
		Group {
			if let content {
				switch artifact.kind {
				case "html":
					SealedPage(html: content)
				case "chart":
					if let chart = try? JSONDecoder().decode(ChartData.self, from: Data(content.utf8)) {
						ScrollView { ChartView(chart: chart).padding() }
					} else {
						unreadable
					}
				case "markdown":
					ScrollView {
						Text(Self.markdown(content))
							.textSelection(.enabled)
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding()
					}
				default:
					ScrollView {
						Text(Self.pretty(content))
							.font(.footnote.monospaced())
							.textSelection(.enabled)
							.frame(maxWidth: .infinity, alignment: .leading)
							.padding()
					}
				}
			} else if failed {
				unreadable
			} else {
				ProgressView()
			}
		}
		.navigationTitle(artifact.name)
		.navigationBarTitleDisplayMode(.inline)
		.task(id: artifact.version) {
			if let text = await model.artifactText(artifact) { content = text } else { failed = true }
		}
	}

	private var unreadable: some View {
		ContentUnavailableView {
			Label {
				Text("This artifact cannot be shown")
			} icon: {
				Mascot(pose: .sorry)
			}
		}
	}

	/// Markdown as the system draws it, line breaks kept; plain text when it does not parse.
	private static func markdown(_ text: String) -> AttributedString {
		let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
		return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
	}

	private static func pretty(_ text: String) -> String {
		guard let value = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]),
			let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]),
			let pretty = String(data: data, encoding: .utf8)
		else { return text }
		return pretty
	}
}

/// A chart artifact's data: bars or lines over labels (src/server/artifacts.ts).
struct ChartData: Decodable {
	struct Series: Decodable {
		let name: String
		let values: [Double]
	}

	let type: String
	let title: String?
	let labels: [Label]
	let series: [Series]

	/// A label is text or a number.
	struct Label: Decodable {
		let text: String

		init(from decoder: any Decoder) throws {
			let value = try decoder.singleValueContainer()
			if let string = try? value.decode(String.self) {
				text = string
			} else {
				text = String(try value.decode(Double.self).formatted())
			}
		}
	}
}

struct ChartView: View {
	let chart: ChartData

	private struct Point: Identifiable {
		let id: String
		let label: String
		let series: String
		let value: Double
	}

	private var points: [Point] {
		chart.series.flatMap { series in
			zip(chart.labels.indices, series.values).map { index, value in
				Point(id: "\(series.name)-\(index)", label: chart.labels[index].text, series: series.name, value: value)
			}
		}
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			if let title = chart.title, !title.isEmpty {
				Text(title).font(.headline)
			}
			Chart(points) { point in
				if chart.type == "line" {
					LineMark(x: .value("Label", point.label), y: .value("Value", point.value))
						.foregroundStyle(by: .value("Series", point.series))
				} else {
					BarMark(x: .value("Label", point.label), y: .value("Value", point.value))
						.foregroundStyle(by: .value("Series", point.series))
						.position(by: .value("Series", point.series))
				}
			}
			// Black, white and gray, as the rest of Yew: series differ by shade.
			.chartForegroundStyleScale(range: [0.9, 0.5, 0.3, 0.7, 0.4, 0.6, 0.2, 0.8].map { Color.primary.opacity($0) })
			.chartLegend(chart.series.count > 1 ? .visible : .hidden)
			.frame(height: 260)
		}
	}
}

/// An HTML artifact, shut in: no address of its own, and a policy that stops every request, so its
/// scripts can run but cannot reach Yew, the Mac or the network.
struct SealedPage: UIViewRepresentable {
	let html: String

	private static let policy =
		"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:\">"

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.isOpaque = false
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		view.loadHTMLString(Self.policy + html, baseURL: nil)
	}
}
