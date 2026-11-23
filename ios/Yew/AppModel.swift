import Foundation
import Observation

/// What the app knows about the Yew it is connected to, and the actions the screens take.
@MainActor
@Observable
final class AppModel {
	/// How the connection to the Mac is doing, for the banner and the settings screen.
	enum Link: Equatable {
		case connecting
		case online
		/// The relay answers, but the Mac is not connected to it.
		case macOffline
		/// The Mac refused this phone: it was removed there.
		case refused
		/// The relay (or, in Debug, the Mac itself) cannot be reached.
		case unreachable
	}

	private(set) var client: YewClient?
	private var channel: RelayChannel?
	private(set) var sessions: [SessionSummary] = []
	private(set) var center: Center?
	private(set) var letters: [LetterItem] = []
	private(set) var artifacts: [ArtifactItem] = []
	/// The Mac this phone is paired with, as the Mac names itself.
	private(set) var desktopName: String?
	private(set) var link: Link = .connecting
	/// Sample data instead of a Mac: a first look without pairing, and what App Review uses.
	private(set) var isDemo = false
	/// What the Mac said when it refused a request, shown to the person.
	var problem: String?
	var showingSettings = false

	enum Tab: Hashable { case sessions, approvals, letters, artifacts }
	/// The tab in front, and the session open in the sessions tab: where a screen can send the person.
	var tab: Tab = .sessions
	var sessionPath: [SessionSummary] = []
	/// The session to open once the list has it: from a tapped notification, or `-YewSession <id>` in Debug.
	private var sessionToOpen: String?
	/// This phone's APNs token, and the one the Mac was last given.
	private var apnsToken: String?
	private var tokenOnMac: String?
	#if DEBUG
	/// `-YewSettings YES` or `-YewSettings about`: what the settings sheet opens at.
	let settingsAtLaunch = UserDefaults.standard.string(forKey: "YewSettings")
	#endif

	private static let directKey = "directBase"

	init() {
		#if DEBUG
		// `-YewReset YES` starts as if newly installed: no pairing, no saved address.
		if UserDefaults.standard.bool(forKey: "YewReset") {
			Vault.forget()
			UserDefaults.standard.removeObject(forKey: Self.directKey)
		}
		#endif
		if let pairing = Vault.pairing {
			use(RelayChannel(pairing: pairing, key: Vault.phoneKey()))
			desktopName = pairing.desktopName
		}
		#if DEBUG
		// The cookie survives in the shared cookie store; the address is all the app has to remember.
		if let saved = UserDefaults.standard.string(forKey: Self.directKey), let base = URL(string: saved) {
			client = YewClient(transport: DirectTransport(base: base))
		}
		// `-YewDirectLink <link>` at launch connects at once (simulator runs and UI tests).
		if let link = UserDefaults.standard.string(forKey: "YewDirectLink") {
			Task { await connectDirect(link: link) }
		}
		// `-YewPairLink <yew://pair?…>` pairs through the relay at launch, as scanning would.
		if let link = UserDefaults.standard.string(forKey: "YewPairLink") {
			Task { await pair(with: link) }
		}
		// `-YewDemo YES` opens the demo; with `-YewTab`, `-YewSession` and `-YewSettings` a screen of it
		// (screenshots, including the App Store's).
		if UserDefaults.standard.bool(forKey: "YewDemo") { startDemo() }
		switch UserDefaults.standard.string(forKey: "YewTab") {
		case "approvals": tab = .approvals
		case "letters": tab = .letters
		case "artifacts": tab = .artifacts
		default: break
		}
		if settingsAtLaunch != nil { showingSettings = true }
		sessionToOpen = UserDefaults.standard.string(forKey: "YewSession")
		#endif
	}

	var connected: Bool { client != nil }

	/// The lists hold what the Mac has, so an empty one means there is nothing (not that it can't be reached).
	var loaded: Bool { isDemo || link == .online }

	/// Sessions in the order the Mac's sidebar shows them: pinned first, then the rest.
	var orderedSessions: [SessionSummary] {
		sessions.filter(\.pinned) + sessions.filter { !$0.pinned }
	}

	func name(of sessionId: String) -> String {
		sessions.first { $0.id == sessionId }?.name ?? ""
	}

	private func use(_ channel: RelayChannel) {
		self.channel = channel
		client = YewClient(transport: RelayTransport(channel: channel))
	}

	#if DEBUG
	func connectDirect(link: String) async {
		do {
			let (client, base) = try await YewClient.direct(link: link)
			UserDefaults.standard.set(base.absoluteString, forKey: Self.directKey)
			self.client = client
			problem = nil
			await refreshAll()
		} catch {
			problem = error.localizedDescription
		}
	}
	#endif

	/// Pairs with the Mac whose QR code (or its link) this is: handshake with its secret, then keep it.
	func pair(with text: String) async {
		guard let link = PairingLink(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
			problem = String(localized: "That is not a Yew Harness pairing link.")
			return
		}
		var pairing = Pairing(relay: link.relay, desktop: link.desktop, desktopKey: link.key, desktopName: link.name)
		let channel = RelayChannel(pairing: pairing, key: Vault.phoneKey())
		do {
			let welcome = try await channel.connect(pairSecret: link.secret)
			pairing.desktopName = welcome.desktop
			pairing.deviceId = welcome.device
			Vault.pairing = pairing
			desktopName = welcome.desktop
			use(channel)
			self.link = .online
			problem = nil
			await refreshAll()
			await notifications()
		} catch RelayError.macOffline {
			problem = String(localized: "The Mac is not online. Keep Yew Harness running on the Mac with phone access on, then scan again.")
		} catch {
			problem = String(localized: "Pairing did not work. Show a new QR code on the Mac and scan it again.")
		}
	}

	/// Unpairs: the Mac removes this phone from its list when it can be reached, and the phone forgets
	/// the pairing and its key either way.
	func unpair() async {
		if let client, let id = Vault.pairing?.deviceId {
			// The Mac closes this phone's channel as it removes it, so no answer comes back; and an
			// offline Mac is not waited for long.
			let removal = Task { try? await client.delete("/api/devices/\(id)") }
			let limit = Task {
				try? await Task.sleep(for: .seconds(5))
				removal.cancel()
			}
			await removal.value
			limit.cancel()
		}
		await channel?.close()
		Vault.forget()
		#if DEBUG
		UserDefaults.standard.removeObject(forKey: Self.directKey)
		#endif
		reset()
	}

	func startDemo() {
		reset()
		isDemo = true
		desktopName = String(localized: "Demo Mac")
		client = YewClient(transport: DemoTransport())
		link = .online
	}

	func leaveDemo() {
		reset()
	}

	private func reset() {
		channel = nil
		client = nil
		isDemo = false
		desktopName = nil
		link = .connecting
		sessions = []
		center = nil
		letters = []
		artifacts = []
		tokenOnMac = nil
		sessionToOpen = nil
		problem = nil
		showingSettings = false
		tab = .sessions
		sessionPath = []
	}

	func refreshAll() async {
		await refreshSessions()
		await refreshCenter()
		await refreshLetters()
		await refreshArtifacts()
	}

	func refreshArtifacts() async {
		await attempt { artifacts = try await $0.get("/api/artifacts?limit=200", as: Page<ArtifactItem>.self).items }
	}

	/// The latest version's text, as the session saved it.
	func artifactText(_ artifact: ArtifactItem) async -> String? {
		var result: String?
		await attempt { result = try await $0.text("/api/artifacts/\(artifact.id)/versions/\(artifact.version)") }
		return result
	}

	func refreshSessions() async {
		await attempt { sessions = try await $0.get("/api/sessions?limit=200", as: Page<SessionSummary>.self).items }
		if let id = sessionToOpen, let session = sessions.first(where: { $0.id == id }) {
			sessionToOpen = nil
			showingSettings = false
			tab = .sessions
			sessionPath = [session]
		}
	}

	func refreshCenter() async {
		await attempt { center = try await $0.get("/api/center", as: Center.self) }
		if paired, let center { await PushCenter.show(waiting: center.count) }
	}

	// MARK: Notifications

	/// Paired with a Mac through the relay: not the demo, and not Debug's direct connection.
	private var paired: Bool { !isDemo && channel != nil }

	/// Once paired: asks to send notifications the first time, and gives the Mac this phone's token.
	func notifications() async {
		guard paired else { return }
		await PushCenter.turnOn()
		await sendPushToken()
	}

	/// Apple gave this phone a token (again): the Mac gets it.
	func pushToken(_ token: String) {
		guard token != apnsToken else { return }
		apnsToken = token
		Task { await sendPushToken() }
	}

	private struct TokenPatch: Encodable, Sendable {
		let pushToken: String
	}

	private func sendPushToken() async {
		guard paired, let client, let token = apnsToken, let id = Vault.pairing?.deviceId else { return }
		// Apple has two services: builds run from Xcode get tokens for the sandbox one.
		#if DEBUG
		let value = "sandbox:\(token)"
		#else
		let value = "production:\(token)"
		#endif
		guard value != tokenOnMac else { return }
		// Quietly: a Mac that is offline now gets it the next time the phone connects.
		if (try? await client.patch("/api/devices/\(id)", TokenPatch(pushToken: value))) != nil {
			tokenOnMac = value
		}
	}

	/// A notification was tapped: its session, or the approval center.
	func open(session: String?) {
		showingSettings = false
		guard let session else {
			tab = .approvals
			return
		}
		sessionToOpen = session
		Task { await refreshSessions() }
	}

	func refreshLetters() async {
		await attempt { letters = try await $0.get("/api/letters?limit=100", as: Page<LetterItem>.self).items }
	}

	func transcript(of sessionId: String) async -> Transcript? {
		var result: Transcript?
		await attempt { result = try await $0.get("/api/sessions/\(sessionId)/transcript?limit=100", as: Transcript.self) }
		return result
	}

	private struct SendBody: Encodable, Sendable {
		let text: String
		let attachments: [String]?
	}

	private struct UploadAttachmentBody: Encodable, Sendable {
		let name: String
		let mimeType: String
		let data: String
	}

	private var attachmentCache: [String: Data] = [:]

	func send(_ text: String, attachments: [String] = [], to sessionId: String) async -> Bool {
		var sent = false
		let body = SendBody(text: text, attachments: attachments.isEmpty ? nil : attachments)
		await attempt {
			try await $0.post("/api/sessions/\(sessionId)/messages", body)
			sent = true
		}
		return sent
	}

	func uploadAttachment(sessionId: String, name: String, mimeType: String, data: Data) async -> AttachmentRef? {
		var uploaded: AttachmentRef?
		let payload = UploadAttachmentBody(name: name, mimeType: mimeType, data: data.base64EncodedString())
		await attempt {
			let raw = try await $0.post("/api/sessions/\(sessionId)/attachments", payload)
			uploaded = try JSONDecoder().decode(AttachmentRef.self, from: raw)
		}
		return uploaded
	}

	func deletePendingAttachment(sessionId: String, attachmentId: String) async {
		try? await client?.delete("/api/sessions/\(sessionId)/attachments/\(attachmentId)")
	}

	func fetchAttachmentData(id: String, thumb: Bool) async -> Data? {
		let cacheKey = "\(id):\(thumb ? "t" : "f")"
		if let cached = attachmentCache[cacheKey] { return cached }
		guard let client else { return nil }
		let path = thumb ? "/api/attachments/\(id)?thumb=1&format=json" : "/api/attachments/\(id)?format=json"
		guard let payload = try? await client.get(path, as: AttachmentPayload.self),
			let bytes = Data(base64Encoded: payload.data)
		else { return nil }
		if attachmentCache.count > 60 { attachmentCache.removeAll() }
		attachmentCache[cacheKey] = bytes
		return bytes
	}

	private struct Unsent: Codable, Sendable { let text: String }

	/// What was typed to a session and not sent, as the Mac keeps it; nil when it could not be read.
	func unsent(of sessionId: String) async -> String? {
		try? await client?.get("/api/unsent/\(sessionId)", as: Unsent.self).text
	}

	/// Keeps what is in a session's message field on the Mac, so it is there on every device.
	func keepUnsent(_ text: String, of sessionId: String) async {
		_ = try? await client?.put("/api/unsent/\(sessionId)", Unsent(text: text))
	}

	/// Stops what the session is doing; your next message sets it going again.
	func stop(_ sessionId: String) async {
		await attempt { try await $0.post("/api/sessions/\(sessionId)/stop", [String: String]()) }
	}

	enum Decision: String {
		case allowOnce = "allow_once"
		case allowAlways = "allow_always"
		case deny
	}

	private struct ApprovalAnswerBody: Encodable, Sendable {
		let decision: String
		let confirmedWarning: Bool?
	}

	/// Answers a permission request: allow once, always allow this kind, or decline.
	func answer(_ approvalId: String, _ decision: Decision, confirmedWarning: Bool = false) async {
		let body = ApprovalAnswerBody(
			decision: decision.rawValue,
			confirmedWarning: confirmedWarning ? true : nil
		)
		await attempt { try await $0.post("/api/approvals/\(approvalId)", body) }
		await refreshCenter()
	}

	struct Answer: Encodable, Sendable {
		let choices: [Int]
		let text: String?
	}

	private struct Answers: Encodable, Sendable {
		let answers: [Answer]
	}

	/// Answers a question card: the options picked and the person's own words, per question.
	func answer(_ approvalId: String, answers: [Answer]) async -> Bool {
		var done = false
		await attempt {
			try await $0.post("/api/approvals/\(approvalId)", Answers(answers: answers))
			done = true
		}
		await refreshCenter()
		return done
	}

	private struct Decide: Encodable, Sendable {
		let choice: Int?
		let note: String?
	}

	/// Sends the person's decision on a card; it goes back to the sessions that asked.
	func decide(_ cardId: String, choice: Int?, note: String?) async -> Bool {
		var done = false
		await attempt {
			try await $0.post("/api/cards/\(cardId)/decide", Decide(choice: choice, note: note))
			done = true
		}
		await refreshCenter()
		return done
	}

	/// Releases a held letter to its recipient, or refuses it.
	func settle(_ letterId: String, release: Bool) async {
		await attempt { try await $0.post("/api/letters/\(letterId)/\(release ? "release" : "refuse")", [String: String]()) }
		await refreshCenter()
		await refreshLetters()
	}

	/// Follows the Mac's event stream and refreshes what changed, so the lists stay current. After a
	/// drop it tries again, less often while the Mac is offline, and reloads once it is back.
	func followEvents() async {
		var reconnecting = false
		while !Task.isCancelled {
			guard let client else { return }
			do {
				for try await event in client.events() {
					switch event.event {
					case "hello":
						link = .online
						if reconnecting { await refreshAll() }
						reconnecting = true
						await notifications()
					case "reset":
						await refreshAll()
					case "global":
						await changed(event.data)
					default:
						break
					}
				}
			} catch is CancellationError {
				return
			} catch {
				note(error)
			}
			reconnecting = true
			try? await Task.sleep(for: link == .online ? .seconds(2) : .seconds(8))
		}
	}

	private func changed(_ data: String) async {
		guard let type = (try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any])?["type"] as? String
		else { return }
		switch type {
		case "sessionSummary", "groups", "sessionsDeleted":
			await refreshSessions()
		case "approval", "card":
			await refreshCenter()
		case "letter":
			await refreshCenter()
			await refreshLetters()
		case "artifact", "artifactDeleted":
			await refreshArtifacts()
		default:
			break
		}
	}

	/// Runs a request; a refusal from the Mac is shown to the person, a lost connection goes to the banner.
	private func attempt(_ work: (YewClient) async throws -> Void) async {
		guard let client else { return }
		do {
			try await work(client)
			link = .online
		} catch is CancellationError {
		} catch let refusal as YewProblem {
			link = .online
			problem = refusal.localizedDescription
		} catch {
			note(error)
		}
	}

	private func note(_ error: any Error) {
		switch error {
		case RelayError.macOffline: link = .macOffline
		case RelayError.refused: link = .refused
		case let error as URLError where error.code == .cancelled: break
		default: link = .unreachable
		}
	}
}
