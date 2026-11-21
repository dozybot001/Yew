import Foundation

/// Sample data for a first look without a Mac, and for App Review: the requests the app sends to Yew,
/// answered here in the same shapes. What you do in the demo changes only the demo.
struct DemoTransport: Transport {
	private let server = DemoServer()

	func send(method: String, path: String, body: Data?) async throws -> (Data, Int) {
		await server.handle(method: method, path: path, body: body)
	}

	/// The demo changes only when you act, and the screens reload after each action, so its event
	/// stream only says hello.
	func stream(path: String) -> AsyncThrowingStream<String, any Error> {
		AsyncThrowingStream { $0.yield("event: hello\ndata: {}\n\n") }
	}
}

private actor DemoServer {
	private var sessions: [[String: Any]] = []
	private var entries: [String: [[String: Any]]] = [:]
	private var approvals: [[String: Any]] = []
	private var cards: [[String: Any]] = []
	private var letters: [[String: Any]] = []
	private var artifacts: [[String: Any]] = []
	private var artifactTexts: [String: String] = [:]
	private var make = DemoBuilder()

	init() {
		var make = DemoBuilder()
		let main = String(localized: "Main")
		let store = String(localized: "Store")
		let design = String(localized: "Design")
		let report = String(localized: "Weekly report")
		sessions = [
			make.session("main", main, status: "idle", pinned: true),
			make.session("website", store, cwd: "~/Projects/website", status: "waiting"),
			make.session("design", design, status: "waiting"),
			make.session("report", report, kind: "task", status: "working"),
		]
		entries["main"] = [
			make.user(String(localized: "What needs me today?"), minutes: 40),
			make.assistant(
				String(localized: "Three things: Store wants to push the sign-in fix, Design asks which accent color to use, and the release date needs your decision (card #12)."),
				minutes: 39
			),
		]
		entries["website"] = [
			make.user(String(localized: "Make a sign-in last 30 minutes, run the tests, then push."), minutes: 25),
			make.assistant(tools: ["read", "grep", "edit"], minutes: 24),
			make.assistant(tools: ["shell", "shell"], minutes: 22),
			make.assistant(
				String(localized: "A sign-in now lasts 30 minutes (`auth/session.ts`), and all 48 tests pass. Pushing needs your permission."),
				minutes: 21
			),
		]
		entries["design"] = [
			make.letterEntry(
				from: main,
				kind: "request",
				body: String(localized: "Draft two color options for the home page."),
				minutes: 15
			),
			make.assistant(tools: ["read", "web_fetch", "write"], minutes: 12),
			make.assistant(String(localized: "Both options are drafted. I've asked which one you prefer."), minutes: 10),
		]
		entries["report"] = [
			make.letterEntry(
				from: main,
				kind: "request",
				body: String(localized: "Write this week's report from the merged changes."),
				minutes: 6
			),
			make.assistant(tools: ["shell", "shell", "read"], minutes: 4),
		]
		approvals = [
			[
				"id": "push", "sessionId": "website", "kind": "permission", "createdAt": make.ago(21),
				"request": [
					"tool": "shell", "summary": "git push origin main",
					"description": String(localized: "Push the sign-in fix"), "mustConfirm": true,
				],
			],
			[
				"id": "color", "sessionId": "design", "kind": "question", "createdAt": make.ago(10),
				"request": [
					"questions": [
						[
							"header": String(localized: "Accent color"),
							"question": String(localized: "Which color should the home page use?"),
							"options": [
								[
									"label": String(localized: "Black, white and grey"),
									"detail": String(localized: "The same as the desktop app."),
								],
								[
									"label": String(localized: "One accent color"),
									"detail": String(localized: "Buttons and links stand out more."),
								],
							],
							"recommended": 0,
						],
					],
				],
			],
		]
		cards = [
			[
				"id": "release", "number": 12, "createdAt": make.ago(30), "requestedBy": "website", "createdBy": "main",
				"undoable": true,
				"title": String(localized: "Release on Friday or next Monday?"),
				"context": String(localized: "Two fixes are still in review. Friday ships sooner; Monday leaves a day for testing."),
				"options": [
					[
						"label": String(localized: "Friday"),
						"detail": String(localized: "Ship the reviewed fixes now; the rest go next week."),
					],
					[
						"label": String(localized: "Next Monday"),
						"detail": String(localized: "All fixes go out together."),
					],
				],
				"recommended": 1,
			],
		]
		letters = [
			make.letter(
				"held", from: report, to: "website", kind: "request", status: "held",
				summary: String(localized: "Please add the release date to the changelog."), minutes: 5
			),
			make.letter(
				"l3", from: design, to: "main", kind: "report", status: "delivered",
				summary: String(localized: "Both color options are drafted; waiting for your pick."), minutes: 10
			),
			make.letter(
				"l2", from: main, to: "design", kind: "request", status: "delivered",
				summary: String(localized: "Draft two color options for the home page."), minutes: 15
			),
			make.letter(
				"l1", from: main, to: "report", kind: "request", status: "delivered",
				summary: String(localized: "Write this week's report from the merged changes."), minutes: 6
			),
		]
		let now = Date().timeIntervalSince1970 * 1000
		let reportTitle = String(localized: "This week's report")
		let chartTitle = String(localized: "Merged changes per day")
		artifacts = [
			["id": "a1", "sessionId": "report", "name": reportTitle, "kind": "markdown", "version": 2, "updatedAt": now - 300_000],
			["id": "a2", "sessionId": "report", "name": chartTitle, "kind": "chart", "version": 1, "updatedAt": now - 600_000],
		]
		artifactTexts["a1"] = String(localized: "**This week**\n\n- The checkout page loads in under a second.\n- Two color options for the home page are drafted.\n- The weekly report now writes itself every Friday.")
		artifactTexts["a2"] = "{\"type\":\"bar\",\"title\":\"\(chartTitle)\",\"labels\":[\"1\",\"2\",\"3\",\"4\",\"5\"],\"series\":[{\"name\":\"\(store)\",\"values\":[3,5,2,6,4]}]}"
		self.make = make
	}

	func handle(method: String, path: String, body: Data?) -> (Data, Int) {
		let route = path.split(separator: "?").first.map(String.init) ?? path
		let parts = route.split(separator: "/").map(String.init)
		let fields = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
		switch (method, parts.count) {
		case ("GET", 2) where parts[1] == "sessions":
			return json(["items": sessions, "nextCursor": NSNull()])
		case ("GET", 4) where parts[1] == "sessions" && parts[3] == "transcript":
			guard let session = sessions.first(where: { $0["id"] as? String == parts[2] }) else { return missing() }
			return json([
				"session": session, "entries": entries[parts[2]] ?? [], "toolCalls": [], "approvals": [],
				"queue": [], "olderCursor": NSNull(),
			])
		case ("GET", 2) where parts[1] == "artifacts":
			return json(["items": artifacts, "nextCursor": NSNull()])
		case ("GET", 5) where parts[1] == "artifacts" && parts[3] == "versions":
			guard let text = artifactTexts[parts[2]] else { return missing() }
			return (Data(text.utf8), 200)
		case ("GET", 2) where parts[1] == "center":
			return json([
				"approvals": approvals, "cards": cards,
				"held": letters.filter { $0["status"] as? String == "held" },
			])
		case ("GET", 2) where parts[1] == "letters":
			return json(["items": letters, "nextCursor": NSNull()])
		case ("POST", 3) where parts[1] == "approvals":
			guard let approval = approvals.first(where: { $0["id"] as? String == parts[2] }) else { return missing() }
			approvals.removeAll { $0["id"] as? String == parts[2] }
			let sessionId = approval["sessionId"] as? String ?? ""
			if approval["kind"] as? String == "permission" {
				let allowed = fields["decision"] as? String != "deny"
				append(
					make.assistant(allowed ? String(localized: "Pushed to origin/main.") : String(localized: "Not pushed."), minutes: 0),
					to: sessionId
				)
			}
			setStatus("idle", of: sessionId)
			return json([:])
		case ("POST", 4) where parts[1] == "cards" && parts[3] == "decide":
			cards.removeAll { $0["id"] as? String == parts[2] }
			return json([:])
		case ("POST", 4) where parts[1] == "letters":
			guard let index = letters.firstIndex(where: { $0["id"] as? String == parts[2] }) else { return missing() }
			letters[index]["status"] = parts[3] == "release" ? "delivered" : "refused"
			return json([:])
		case ("POST", 4) where parts[1] == "sessions" && parts[3] == "messages":
			append(make.user(fields["text"] as? String ?? "", minutes: 0), to: parts[2])
			append(
				make.assistant(String(localized: "This is the demo: no session received your message."), minutes: 0),
				to: parts[2]
			)
			setStatus("idle", of: parts[2])
			return json([:], status: 201)
		case ("POST", 4) where parts[1] == "sessions" && parts[3] == "stop":
			setStatus("idle", of: parts[2])
			return (Data(), 204)
		default:
			return missing()
		}
	}

	private func json(_ value: Any, status: Int = 200) -> (Data, Int) {
		((try? JSONSerialization.data(withJSONObject: value)) ?? Data(), status)
	}

	private func missing() -> (Data, Int) {
		json(["title": "Not Found", "status": 404], status: 404)
	}

	private func append(_ entry: [String: Any], to sessionId: String) {
		entries[sessionId, default: []].append(entry)
		guard let index = sessions.firstIndex(where: { $0["id"] as? String == sessionId }) else { return }
		sessions[index]["eventSeq"] = make.seq
	}

	private func setStatus(_ status: String, of sessionId: String) {
		guard let index = sessions.firstIndex(where: { $0["id"] as? String == sessionId }) else { return }
		sessions[index]["status"] = status
	}
}

/// Builds the demo's records in the API's shapes; numbers entries as the Mac does.
private struct DemoBuilder {
	var seq = 0

	func ago(_ minutes: Double) -> Double {
		(Date().timeIntervalSince1970 - minutes * 60) * 1000
	}

	func session(
		_ id: String,
		_ name: String,
		kind: String = "standing",
		cwd: String? = nil,
		status: String,
		pinned: Bool = false,
		unread: Int = 0
	) -> [String: Any] {
		[
			"id": id, "name": name, "kind": kind, "cwd": cwd ?? NSNull(), "status": status, "pinned": pinned,
			"unread": unread, "groupId": NSNull(), "parentId": NSNull(), "eventSeq": 0,
		]
	}

	mutating func entry(_ role: String, _ fields: [String: Any], minutes: Double) -> [String: Any] {
		seq += 1
		return fields.merging(["id": "e\(seq)", "seq": seq, "role": role, "createdAt": ago(minutes)]) { $1 }
	}

	mutating func user(_ text: String, minutes: Double) -> [String: Any] {
		entry("user", ["message": ["role": "user", "content": text]], minutes: minutes)
	}

	mutating func assistant(_ text: String = "", tools: [String] = [], minutes: Double) -> [String: Any] {
		var content: [[String: Any]] = tools.map { ["type": "toolCall", "id": UUID().uuidString, "name": $0, "arguments": [:]] }
		if !text.isEmpty { content.append(["type": "text", "text": text]) }
		return entry("assistant", ["message": ["role": "assistant", "content": content]], minutes: minutes)
	}

	mutating func letterEntry(from name: String, kind: String, body: String, minutes: Double) -> [String: Any] {
		entry(
			"user",
			[
				"message": ["role": "user", "content": body],
				"letter": [
					"id": "l2", "kind": kind, "from": ["kind": "session", "sessionId": "main", "name": name],
					"summary": body, "body": body,
				],
			],
			minutes: minutes
		)
	}

	func letter(
		_ id: String,
		from: String,
		to: String,
		kind: String,
		status: String,
		summary: String,
		minutes: Double
	) -> [String: Any] {
		[
			"id": id, "fromName": from, "toSession": to, "kind": kind, "summary": summary, "body": summary,
			"status": status, "statusReason": NSNull(), "createdAt": ago(minutes),
		]
	}
}
