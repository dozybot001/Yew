import SwiftUI

/// Settings, from the button at the top right of each tab: the Mac this phone is paired with, unpairing,
/// and About. Everything else is set on the Mac.
struct SettingsView: View {
	@Environment(AppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var confirming = false
	@State private var leaving = false
	@State private var path: [String] = []
	@State private var notifications: PushCenter.State?

	var body: some View {
		NavigationStack(path: $path) {
			Form {
				Section {
					LabeledContent("Mac", value: model.desktopName ?? "")
					LabeledContent("Connection", value: LinkText.status(model.link, demo: model.isDemo))
				} footer: {
					if model.isDemo {
						Text("This is sample data. Nothing you do here reaches a Mac.")
					} else {
						Text("Your iPhone and the Mac are encrypted end to end; the relay only passes ciphertext along.")
					}
				}
				if !model.isDemo, let notifications {
					Section {
						LabeledContent("Notifications", value: notificationText(notifications))
						switch notifications {
						case .on:
							EmptyView()
						case .notAsked:
							Button("Turn on notifications") {
								Task {
									await model.notifications()
									self.notifications = await PushCenter.state()
								}
							}
						case .off:
							Button("Open iOS Settings") {
								if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
									UIApplication.shared.open(url)
								}
							}
						}
					} footer: {
						Text(
							"Yew Harness notifies this iPhone when something needs you (a permission, a question, a decision or a held letter), when a session stops with an error, and when a task finishes. What a notification says is encrypted for this iPhone; the relay and Apple cannot read it."
						)
					}
				}
				Section {
					if model.isDemo {
						Button("Leave the demo") { model.leaveDemo() }
					} else {
						Button("Unpair", role: .destructive) { confirming = true }
							.disabled(leaving)
					}
				}
				Section {
					NavigationLink("About Yew Harness", value: "about")
				}
			}
			.navigationDestination(for: String.self) { _ in AboutView() }
			.task { notifications = await PushCenter.state() }
			.navigationTitle("Settings")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
			.confirmationDialog("Unpair this iPhone?", isPresented: $confirming, titleVisibility: .visible) {
				Button("Unpair", role: .destructive) {
					leaving = true
					Task { await model.unpair() }
				}
			} message: {
				Text("The Mac removes this iPhone from its list. To use Yew Harness here again, show a new QR code on the Mac and scan it.")
			}
		}
		#if DEBUG
		.onAppear { if model.settingsAtLaunch == "about" { path = ["about"] } }
		#endif
	}
}

private func notificationText(_ state: PushCenter.State) -> String {
	switch state {
	case .on: String(localized: "On")
	case .off: String(localized: "Off in iOS Settings")
	case .notAsked: String(localized: "Not turned on")
	}
}

/// What the connection is doing, in words, for the settings screen and the banner.
enum LinkText {
	static func status(_ link: AppModel.Link, demo: Bool) -> String {
		if demo { return String(localized: "Demo") }
		switch link {
		case .connecting: return String(localized: "Connecting…")
		case .online: return String(localized: "Connected")
		case .macOffline: return String(localized: "Mac offline")
		case .refused: return String(localized: "Removed on the Mac")
		case .unreachable: return String(localized: "Can't connect")
		}
	}
}

/// "About Yew Harness": the lockup, version and build, what Yew is, the publisher and website,
/// then the privacy policy, terms and feedback.
struct AboutView: View {
	private var version: String {
		let info = Bundle.main.infoDictionary
		let number = info?["CFBundleShortVersionString"] as? String ?? ""
		let build = info?["CFBundleVersion"] as? String ?? ""
		return String(localized: "Version \(number) · Build \(build)")
	}

	var body: some View {
		List {
			Section {
				VStack(spacing: 10) {
					Mascot(pose: .gift, height: 100)
					Lockup()
					Text(version)
						.font(.footnote.monospacedDigit())
						.foregroundStyle(.secondary)
				}
				.frame(maxWidth: .infinity)
				.padding(.vertical, 8)
			}
			Section {
				Text("An AI-native multi-agent workbench. Yew Harness organizes agent sessions the Session Engineering way: you deal only with the main conversation, and everything that needs your approval or decision comes to the approval center. The sessions run in Yew Harness on your Mac.")
				Text("Yew Harness on iPhone connects to your Mac through a relay, encrypted end to end. Away from your desk, you handle what needs you here: allow operations, answer the sessions' questions and decide on cards, and you can follow and reply to sessions.")
			}
			Section {
				// The small horizontal publisher mark: the T at least 16 pt, the name about
				// 0.75 of it, semibold, 0.3 of it apart.
				LabeledContent("Publisher") {
					HStack(spacing: 18 * 0.3) {
						Image("TenonMark")
							.resizable()
							.frame(width: 18, height: 18)
							.accessibilityHidden(true)
						Text("Tenon AI").font(.system(size: 18 * 0.75, weight: .semibold))
					}
				}
				Link(destination: URL(string: "https://tenonai.cn/")!) {
					LabeledContent("Website", value: "tenonai.cn")
				}
			}
			Section {
				NavigationLink("Privacy Policy") { PolicyView(kind: .privacy) }
				NavigationLink("Terms of Service") { PolicyView(kind: .terms) }
				Link(destination: URL(string: "mailto:support@tenonai.cn")!) {
					LabeledContent("Feedback", value: "support@tenonai.cn")
				}
			}
		}
		.tint(.primary)
		.navigationTitle("About Yew Harness")
		.navigationBarTitleDisplayMode(.inline)
	}
}

/// The privacy policy or the terms: the same text as Yew on the Mac (src/shared/policy.ts).
struct PolicyView: View {
	enum Kind { case privacy, terms }
	let kind: Kind

	var body: some View {
		let text = kind == .privacy ? String(localized: "policy.privacy") : String(localized: "policy.terms")
		ScrollView {
			VStack(alignment: .leading, spacing: 14) {
				Text("Version \(String(localized: "policy.version")) · effective \(String(localized: "policy.date"))")
					.font(.footnote)
					.foregroundStyle(.secondary)
				ForEach(Array(text.components(separatedBy: "\n\n").enumerated()), id: \.offset) { _, paragraph in
					Text(paragraph)
				}
			}
			.textSelection(.enabled)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding()
		}
		.navigationTitle(kind == .privacy ? LocalizedStringKey("Privacy Policy") : LocalizedStringKey("Terms of Service"))
		.navigationBarTitleDisplayMode(.inline)
	}
}

/// The full lockup for the first screen and the About page: the mark and the wordmark ("Yew"
/// outlined from Young Serif, in the ink colour) with a smaller "Harness" after it, which make the
/// product's name Yew Harness, sized from the wordmark's size S. No Tenon mark: that appears only
/// with "Tenon AI", where the publisher is named.
struct Lockup: View {
	var size: CGFloat = 36

	var body: some View {
		HStack(spacing: size * 0.3) {
			YewMark()
				.frame(width: size, height: size)
			HStack(alignment: .bottom, spacing: size * 0.25) {
				// The wordmark's box is one em of the font, as wide as its viewBox says.
				Image("YewWordmark")
					.resizable()
					.frame(width: size * 2.091, height: size)
					.foregroundStyle(Color.yewInk)
				// On the wordmark's baseline, 0.16 S above the bottom of its box.
				Text(verbatim: "Harness")
					.font(.system(size: size * 0.64, weight: .semibold))
					.foregroundStyle(Color.yewInk)
					.fixedSize()
					.alignmentGuide(.bottom) { d in d[.lastTextBaseline] + size * 0.16 }
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Text(verbatim: "Yew Harness"))
	}
}

extension View {
	/// What the first screen of each tab has: the settings button, and a banner while the Mac can't be
	/// reached or the app shows sample data.
	func yewChrome() -> some View {
		modifier(YewChrome())
	}
}

private struct YewChrome: ViewModifier {
	@Environment(AppModel.self) private var model

	func body(content: Content) -> some View {
		content
			.safeAreaInset(edge: .bottom, spacing: 0) { Banner() }
			.toolbar {
				ToolbarItem(placement: .topBarTrailing) {
					Button {
						model.showingSettings = true
					} label: {
						Label("Settings", systemImage: "gearshape")
					}
				}
			}
	}
}

/// One line about the connection when something needs saying, with what the person can do about it.
private struct Banner: View {
	@Environment(AppModel.self) private var model

	var body: some View {
		if model.isDemo {
			line(
				"Sample data: nothing reaches a Mac.",
				action: ("Leave", { model.leaveDemo() })
			)
		} else {
			switch model.link {
			case .macOffline:
				line(
					"The Mac is offline. Keep Yew Harness running there with phone access on.",
					action: ("Retry", { Task { await model.refreshAll() } })
				)
			case .refused:
				line(
					"The Mac no longer knows this iPhone. Pair again to keep using it.",
					action: ("Pair again", { Task { await model.unpair() } })
				)
			case .unreachable:
				line(
					"Can't connect. Check the network; Yew Harness keeps trying.",
					action: ("Retry", { Task { await model.refreshAll() } })
				)
			case .connecting, .online:
				EmptyView()
			}
		}
	}

	private func line(_ text: LocalizedStringKey, action: (LocalizedStringKey, () -> Void)) -> some View {
		HStack(spacing: 10) {
			Text(text)
				.font(.footnote)
				.frame(maxWidth: .infinity, alignment: .leading)
			Button(action.0, action: action.1)
				.font(.footnote.weight(.semibold))
				.buttonStyle(.borderless)
				.frame(minHeight: 44)
		}
		.tint(.primary)
		.padding(.horizontal, 16)
		.padding(.vertical, 2)
		.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
		.overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.yewControl))
		.padding(.horizontal)
		.padding(.bottom, 8)
	}
}
