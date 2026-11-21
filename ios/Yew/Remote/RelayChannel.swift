import CryptoKit
import Foundation
import UIKit

/// The phone's end of the encrypted channel to the Mac, through the relay: a Noise IK handshake with
/// the Mac's key from the pairing, then the same requests the web interface sends to the Mac's local
/// API, encrypted end to end. It reconnects on the next request after a drop.
actor RelayChannel {
	private let pairing: Pairing
	private let key: Curve25519.KeyAgreement.PrivateKey // gitleaks:allow (a type, not a key)
	private var socket: URLSessionWebSocketTask?
	private var sender: NoiseCipher?
	private var opener: NoiseOpener?
	private var nextId = 1
	private var waiting: [Int: CheckedContinuation<(Data, Int), any Error>] = [:]
	private var streams: [Int: AsyncThrowingStream<String, any Error>.Continuation] = [:]
	private var streamIds: [UUID: Int] = [:]

	init(pairing: Pairing, key: Curve25519.KeyAgreement.PrivateKey) {
		self.pairing = pairing
		self.key = key
	}

	struct Welcome: Decodable, Sendable {
		let desktop: String
		let version: String
		let device: String
	}

	private struct Hello: Encodable {
		let pair: String?
		let name: String
		let app: String
	}

	/// Shakes hands with the Mac; `pairSecret` is the QR code's secret when this phone is not paired yet.
	@discardableResult
	func connect(pairSecret: String? = nil) async throws -> Welcome {
		close()
		guard let url = URL(string: "\(pairing.relay)/phone/\(pairing.desktop)") else { throw URLError(.badURL) }
		let socket = URLSession.shared.webSocketTask(with: url)
		socket.resume()
		var initiator = NoiseInitiator(
			staticKey: key,
			remoteStatic: pairing.desktopKey,
			prologue: Data("yew-remote/1:\(pairing.desktop)".utf8)
		)
		let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
		let name = await UIDevice.current.name
		let hello = try JSONEncoder().encode(Hello(pair: pairSecret, name: name, app: version))
		let first = try initiator.writeFirst(hello)
		let reply: Data
		do {
			// Giving up on the handshake closes the socket, which ends the wait at once.
			reply = try await withTaskCancellationHandler {
				try await socket.send(.data(first))
				guard case .data(let data) = try await socket.receive() else { throw NoiseError.shortMessage }
				return data
			} onCancel: {
				socket.cancel(with: .goingAway, reason: nil)
			}
		} catch {
			throw RelayError(closedWith: socket.closeCode) ?? error
		}
		let (payload, send, receive) = try initiator.readSecond(reply)
		let welcome = try JSONDecoder().decode(Welcome.self, from: payload)
		self.socket = socket
		sender = send
		opener = NoiseOpener(cipher: receive)
		Task { await self.listen(socket) }
		return welcome
	}

	/// One request to the Mac's local API; the body and status come back as the Mac answered.
	/// Cancelling the calling task gives up on the answer.
	func request(method: String, path: String, body: Data?) async throws -> (Data, Int) {
		try Task.checkCancellation()
		if socket == nil { try await connect() }
		guard let socket, var cipher = sender else { throw URLError(.networkConnectionLost) }
		let id = nextId
		nextId += 1
		// "z": the Mac may answer with the body compressed; long transcripts come much sooner on a slow link.
		var message: [String: Any] = ["t": "req", "id": id, "method": method, "path": path, "z": 1]
		if let body { message["body"] = String(decoding: body, as: UTF8.self) }
		let parts = try noiseSeal(&cipher, JSONSerialization.data(withJSONObject: message))
		sender = cipher
		return try await withTaskCancellationHandler {
			try await withCheckedThrowingContinuation { continuation in
				waiting[id] = continuation
				Task {
					do {
						for part in parts { try await socket.send(.data(part)) }
					} catch {
						self.fail(id, error)
					}
				}
			}
		} onCancel: {
			Task { await self.fail(id, CancellationError()) }
		}
	}

	/// A streamed request (the event stream): text as it comes, until the Mac ends it or the caller stops.
	nonisolated func stream(path: String) -> AsyncThrowingStream<String, any Error> {
		let token = UUID()
		return AsyncThrowingStream { continuation in
			let task = Task { await self.open(path: path, token: token, continuation: continuation) }
			continuation.onTermination = { _ in
				task.cancel()
				Task { await self.cancelStream(token) }
			}
		}
	}

	private func open(
		path: String,
		token: UUID,
		continuation: AsyncThrowingStream<String, any Error>.Continuation
	) async {
		do {
			if socket == nil { try await connect() }
			guard let socket, var cipher = sender else { throw URLError(.networkConnectionLost) }
			let id = nextId
			nextId += 1
			streams[id] = continuation
			streamIds[token] = id
			let parts = try noiseSeal(
				&cipher,
				JSONSerialization.data(withJSONObject: ["t": "req", "id": id, "method": "GET", "path": path])
			)
			sender = cipher
			for part in parts { try await socket.send(.data(part)) }
		} catch {
			continuation.finish(throwing: error)
		}
	}

	private func cancelStream(_ token: UUID) async {
		guard let id = streamIds.removeValue(forKey: token), streams.removeValue(forKey: id) != nil else { return }
		guard let socket, var cipher = sender,
			let parts = try? noiseSeal(&cipher, JSONSerialization.data(withJSONObject: ["t": "cancel", "id": id]))
		else { return }
		sender = cipher
		for part in parts { try? await socket.send(.data(part)) }
	}

	private func listen(_ socket: URLSessionWebSocketTask) async {
		while true {
			do {
				guard case .data(let data) = try await socket.receive(), var opener else { continue }
				let message = try opener.open(data)
				self.opener = opener
				if let message { deliver(message) }
			} catch {
				if self.socket === socket { drop(RelayError(closedWith: socket.closeCode) ?? error) }
				return
			}
		}
	}

	private func deliver(_ data: Data) {
		struct Reply: Decodable {
			let t: String
			let id: Int
			let status: Int?
			let body: String?
			let data: String?
			let z: Int?
		}
		guard let reply = try? JSONDecoder().decode(Reply.self, from: data) else { return }
		switch reply.t {
		case "res":
			guard let waiter = waiting.removeValue(forKey: reply.id) else { return }
			if reply.z == 1 {
				// Base64 of the raw DEFLATE of the body (what NSData calls zlib).
				guard let packed = Data(base64Encoded: reply.body ?? ""),
					let body = try? (packed as NSData).decompressed(using: .zlib) as Data
				else {
					waiter.resume(throwing: URLError(.cannotDecodeContentData))
					return
				}
				waiter.resume(returning: (body, reply.status ?? 0))
			} else {
				waiter.resume(returning: (Data((reply.body ?? "").utf8), reply.status ?? 0))
			}
		case "chunk":
			streams[reply.id]?.yield(reply.data ?? "")
		case "end":
			streams.removeValue(forKey: reply.id)?.finish()
			streamIds = streamIds.filter { $0.value != reply.id }
		default:
			break
		}
	}

	private func fail(_ id: Int, _ error: any Error) {
		waiting.removeValue(forKey: id)?.resume(throwing: error)
	}

	private func drop(_ error: any Error) {
		socket = nil
		sender = nil
		opener = nil
		for continuation in waiting.values { continuation.resume(throwing: error) }
		waiting = [:]
		for continuation in streams.values { continuation.finish(throwing: error) }
		streams = [:]
		streamIds = [:]
	}

	func close() {
		socket?.cancel(with: .goingAway, reason: nil)
		drop(URLError(.cancelled))
	}
}

/// Why the relay closed the connection, when it says (src/remote/protocol.ts, relay/relay.ts).
enum RelayError: LocalizedError, Equatable {
	/// The Mac is not connected to the relay: asleep, Yew not running, or phone access off.
	case macOffline
	/// The Mac closed the channel during the handshake: it no longer knows this phone.
	case refused

	init?(closedWith code: URLSessionWebSocketTask.CloseCode) {
		switch code.rawValue {
		case 4404: self = .macOffline
		case 1000: self = .refused
		default: return nil
		}
	}

	var errorDescription: String? {
		switch self {
		case .macOffline: String(localized: "The Mac is not online.")
		case .refused: String(localized: "The Mac no longer knows this iPhone.")
		}
	}
}

/// Requests through the relay channel. A request the Mac does not answer within 30 seconds fails, so
/// a stalled connection never leaves a screen waiting.
struct RelayTransport: Transport {
	let channel: RelayChannel

	func send(method: String, path: String, body: Data?) async throws -> (Data, Int) {
		try await withThrowingTaskGroup(of: (Data, Int).self) { group in
			group.addTask { try await channel.request(method: method, path: path, body: body) }
			group.addTask {
				try await Task.sleep(for: .seconds(30))
				throw URLError(.timedOut)
			}
			defer { group.cancelAll() }
			guard let result = try await group.next() else { throw URLError(.timedOut) }
			return result
		}
	}

	func stream(path: String) -> AsyncThrowingStream<String, any Error> {
		channel.stream(path: path)
	}
}
