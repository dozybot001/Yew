import Foundation

/// Where the app's requests go. The relay channel and, in Debug builds, a direct connection to
/// `yew serve` on this Mac (the simulator shares the Mac's network).
protocol Transport: Sendable {
	func send(method: String, path: String, body: Data?) async throws -> (Data, Int)
	/// A streamed response, such as the event stream, as text in the pieces it arrives in.
	func stream(path: String) -> AsyncThrowingStream<String, any Error>
}

/// Debug only: talks to `yew serve` on 127.0.0.1 with the cookie a `yew open` link was exchanged for.
struct DirectTransport: Transport {
	let base: URL

	/// Yew accepts writes only from its own origin.
	private var origin: String {
		"\(base.scheme ?? "http")://\(base.host() ?? "127.0.0.1"):\(base.port ?? 80)"
	}

	func stream(path: String) -> AsyncThrowingStream<String, any Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				do {
					guard let url = URL(string: path, relativeTo: base) else { throw URLError(.badURL) }
					let (bytes, _) = try await URLSession.shared.bytes(from: url)
					// Whole lines keep the event stream's shape (blank lines end an event) and UTF-8 intact.
					var line: [UInt8] = []
					for try await byte in bytes {
						line.append(byte)
						if byte == 10 {
							continuation.yield(String(decoding: line, as: UTF8.self))
							line = []
						}
					}
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}

	func send(method: String, path: String, body: Data?) async throws -> (Data, Int) {
		guard let url = URL(string: path, relativeTo: base) else { throw URLError(.badURL) }
		var request = URLRequest(url: url)
		request.httpMethod = method
		request.httpBody = body
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		if method != "GET" { request.setValue(origin, forHTTPHeaderField: "Origin") }
		let (data, response) = try await URLSession.shared.data(for: request)
		return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
	}
}

struct YewClient: Sendable {
	let transport: any Transport

	/// The Mac's event stream: one name and data per event, as the web interface reads them. With a
	/// session it also carries that session's record; `after` replays what came after that sequence number.
	func events(session: String? = nil, after: Int? = nil) -> AsyncThrowingStream<(event: String, data: String), any Error> {
		var path = "/api/events"
		if let session {
			path += "?session=\(session)"
			if let after { path += "&after=\(after)" }
		}
		let raw = transport.stream(path: path)
		return AsyncThrowingStream { continuation in
			let task = Task {
				var buffer = ""
				do {
					for try await piece in raw {
						buffer += piece
						while let end = buffer.range(of: "\n\n") {
							let block = String(buffer[..<end.lowerBound])
							buffer.removeSubrange(..<end.upperBound)
							var name = "message"
							var data: [String] = []
							for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
								if line.hasPrefix("event:") { name = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
								if line.hasPrefix("data:") { data.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
							}
							if !data.isEmpty { continuation.yield((name, data.joined(separator: "\n"))) }
						}
					}
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}

	func get<Value: Decodable & Sendable>(_ path: String, as type: Value.Type = Value.self) async throws -> Value {
		let data = try await call("GET", path, body: nil)
		return try JSONDecoder().decode(Value.self, from: data)
	}

	/// A response that is plain text, such as an artifact's content.
	func text(_ path: String) async throws -> String {
		String(decoding: try await call("GET", path, body: nil), as: UTF8.self)
	}

	@discardableResult
	func post(_ path: String, _ payload: some Encodable & Sendable) async throws -> Data {
		try await call("POST", path, body: JSONEncoder().encode(payload))
	}

	@discardableResult
	func patch(_ path: String, _ payload: some Encodable & Sendable) async throws -> Data {
		try await call("PATCH", path, body: JSONEncoder().encode(payload))
	}

	@discardableResult
	func put(_ path: String, _ payload: some Encodable & Sendable) async throws -> Data {
		try await call("PUT", path, body: JSONEncoder().encode(payload))
	}

	func delete(_ path: String) async throws {
		_ = try await call("DELETE", path, body: nil)
	}

	private func call(_ method: String, _ path: String, body: Data?) async throws -> Data {
		let (data, status) = try await transport.send(method: method, path: path, body: body)
		guard (200..<300).contains(status) else {
			throw (try? JSONDecoder().decode(YewProblem.self, from: data))
				?? YewProblem(title: "HTTP \(status)", detail: nil)
		}
		return data
	}
}

extension YewClient {
	/// Debug only: trades the one-time token of a `yew open` link for the browser cookie.
	static func direct(link: String) async throws -> (YewClient, URL) {
		guard let url = URL(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
			let host = url.host(), let fragment = url.fragment(), fragment.hasPrefix("t=")
		else {
			throw YewProblem(title: String(localized: "Paste the whole link that `yew open` prints."), detail: nil)
		}
		var parts = URLComponents()
		parts.scheme = url.scheme ?? "http"
		parts.host = host
		parts.port = url.port
		guard let base = parts.url else { throw URLError(.badURL) }
		let client = YewClient(transport: DirectTransport(base: base))
		try await client.post("/api/auth/exchange", ["token": String(fragment.dropFirst(2))])
		return (client, base)
	}
}
