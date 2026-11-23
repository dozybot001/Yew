import PhotosUI
import SwiftUI
import UIKit

/// One session: its record, kept current from the Mac's event stream, and a field to write to it.
/// While the session works, the answer appears as it is written, and the send button stops it.
struct SessionView: View {
	@Environment(AppModel.self) private var model
	let session: SessionSummary
	@State private var entries: [Entry] = []
	@State private var toolNotes: [String: [PermissionNote]] = [:]
	@State private var status: String
	@State private var draft: MessageText?
	@State private var message = ""
	@State private var sending = false
	@State private var loaded = false
	@State private var pickedPhotos: [PhotosPickerItem] = []
	@State private var staged: [StagedPhoto] = []
	@State private var uploading = false
	@State private var lightbox: AttachmentRef?
	/// The field's text as the Mac last has it, and the save that waits for typing to pause.
	@State private var kept = ""
	@State private var keeping: Task<Void, Never>?

	struct StagedPhoto: Identifiable {
		let id: String
		let ref: AttachmentRef
		let preview: UIImage
	}

	init(session: SessionSummary) {
		self.session = session
		_status = State(initialValue: session.status)
	}

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 14) {
					ForEach(Step.steps(of: entries, toolNotes: toolNotes)) { step in
						StepView(step: step, onOpenImage: { lightbox = $0 }).id(step.id)
					}
					if let draft, !draft.text.isEmpty {
						AnswerText(text: draft.text)
					}
					if status == "working" {
						Label("Working…", systemImage: "ellipsis")
							.font(.footnote)
							.foregroundStyle(.secondary)
							.symbolEffect(.variableColor.iterative)
					}
					Color.clear.frame(height: 1).id("end")
				}
				.padding()
			}
			.defaultScrollAnchor(.bottom)
			.onChange(of: entries.count) { proxy.scrollTo("end", anchor: .bottom) }
			.onChange(of: draft?.text.count) { proxy.scrollTo("end", anchor: .bottom) }
			.overlay {
				if loaded && entries.isEmpty {
					ContentUnavailableView("No messages yet", systemImage: "bubble.left")
				}
			}
		}
		.safeAreaInset(edge: .bottom) { composer }
		.toolbar(.hidden, for: .tabBar)
		.navigationTitle(session.name)
		.navigationBarTitleDisplayMode(.inline)
		.sheet(item: $lightbox) { ref in
			AttachmentLightbox(attachment: ref)
		}
		.onChange(of: pickedPhotos) { _, items in
			guard !items.isEmpty else { return }
			Task { await handlePicked(items) }
		}
		.task { await follow() }
		.task {
			if let text = await model.unsent(of: session.id), message.isEmpty {
				kept = text
				message = text
			}
		}
		.onChange(of: message) { _, text in keep(text, after: text.isEmpty ? 0 : 500) }
		.onDisappear { keep(message, after: 0) }
	}

	/// Saves the field's text on the Mac once typing pauses; an emptied field and leaving save at once.
	private func keep(_ text: String, after milliseconds: Int) {
		keeping?.cancel()
		guard text != kept else { return }
		let model = model
		let id = session.id
		keeping = Task {
			if milliseconds > 0 {
				try? await Task.sleep(for: .milliseconds(milliseconds))
				if Task.isCancelled { return }
			}
			kept = text
			await model.keepUnsent(text, of: id)
		}
	}

	private var trimmed: String { message.trimmingCharacters(in: .whitespacesAndNewlines) }
	private var canSend: Bool { (!trimmed.isEmpty || !staged.isEmpty) && !sending && !uploading }

	private var composer: some View {
		VStack(spacing: 6) {
			if !staged.isEmpty || uploading {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 8) {
						ForEach(staged) { item in
							ZStack(alignment: .topTrailing) {
								Image(uiImage: item.preview)
									.resizable()
									.scaledToFill()
									.frame(width: 56, height: 56)
									.clipShape(RoundedRectangle(cornerRadius: 10))
								Button {
									removeStaged(item)
								} label: {
									Image(systemName: "xmark.circle.fill")
										.font(.system(size: 18))
										.foregroundStyle(.white, .black.opacity(0.7))
								}
								.offset(x: 4, y: -4)
								.accessibilityLabel("Remove attachment")
							}
							.padding(.top, 4)
							.padding(.trailing, 4)
						}
						if uploading {
							ProgressView()
								.frame(width: 44, height: 56)
						}
					}
					.padding(.horizontal)
				}
			}
			HStack(alignment: .bottom, spacing: 8) {
				PhotosPicker(
					selection: $pickedPhotos,
					maxSelectionCount: max(1, 4 - staged.count),
					matching: .images
				) {
					Image(systemName: "paperclip")
						.font(.system(size: 20))
						.frame(width: 36, height: 44)
				}
				.disabled(staged.count >= 4 || uploading || sending)
				.accessibilityLabel("Attach photo")

				TextField("Message", text: $message, axis: .vertical)
					.lineLimit(1...6)
					.padding(.horizontal, 14)
					.padding(.vertical, 10)
					.background(.background.secondary, in: RoundedRectangle(cornerRadius: 20))
				if status == "working" && trimmed.isEmpty && staged.isEmpty {
					Button {
						Task { await model.stop(session.id) }
					} label: {
						Image(systemName: "stop.circle.fill")
							.font(.system(size: 32))
							.frame(width: 44, height: 44)
					}
					.accessibilityLabel("Stop")
				} else {
					Button(action: send) {
						Image(systemName: "arrow.up.circle.fill")
							.font(.system(size: 32))
							.frame(width: 44, height: 44)
					}
					.disabled(!canSend)
					.accessibilityLabel("Send")
				}
			}
			.tint(.primary)
			.padding(.horizontal)
			.padding(.vertical, 6)
		}
		.background(.bar)
	}

	private func handlePicked(_ items: [PhotosPickerItem]) async {
		pickedPhotos = []
		uploading = true
		defer { uploading = false }
		for item in items where staged.count < 4 {
			guard let raw = try? await item.loadTransferable(type: Data.self),
				let image = UIImage(data: raw),
				let jpeg = compressImage(image)
			else { continue }
			let name = "photo-\(Int(Date().timeIntervalSince1970)).jpg"
			if let ref = await model.uploadAttachment(sessionId: session.id, name: name, mimeType: "image/jpeg", data: jpeg) {
				staged.append(StagedPhoto(id: ref.id, ref: ref, preview: image))
			}
		}
	}

	private func removeStaged(_ photo: StagedPhoto) {
		staged.removeAll { $0.id == photo.id }
		Task { await model.deletePendingAttachment(sessionId: session.id, attachmentId: photo.id) }
	}

	private func compressImage(_ image: UIImage, maxDimension: CGFloat = 2048) -> Data? {
		let size = image.size
		let longest = max(size.width, size.height)
		let target: UIImage
		if longest > maxDimension, longest > 0 {
			let scale = maxDimension / longest
			let newSize = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
			let renderer = UIGraphicsImageRenderer(size: newSize)
			target = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: newSize)) }
		} else {
			target = image
		}
		return target.jpegData(compressionQuality: 0.85)
	}

	private func send() {
		let text = trimmed
		let ids = staged.map(\.id)
		guard !text.isEmpty || !ids.isEmpty else { return }
		sending = true
		Task {
			if await model.send(text, attachments: ids, to: session.id) {
				message = ""
				staged = []
				await load()
			}
			sending = false
		}
	}

	@discardableResult
	private func load() async -> Int? {
		guard let transcript = await model.transcript(of: session.id) else { return nil }
		entries = transcript.entries
		var notes: [String: [PermissionNote]] = [:]
		for call in transcript.toolCalls ?? [] {
			if let note = call.note {
				notes[call.messageId, default: []].append(note)
			}
		}
		toolNotes = notes
		status = transcript.session.status
		loaded = true
		return transcript.session.eventSeq
	}

	/// Reads the record, then follows the session's events from where it ends; after a drop, reads it
	/// again and picks up from there.
	private func follow() async {
		while !Task.isCancelled {
			let after = await load()
			guard let client = model.client else { return }
			do {
				for try await event in client.events(session: session.id, after: after) {
					switch event.event {
					case "session": apply(event.data)
					case "live": applyLive(event.data)
					case "reset": await load()
					default: break
					}
				}
			} catch is CancellationError {
				return
			} catch {}
			try? await Task.sleep(for: .seconds(3))
		}
	}

	private struct Kind: Decodable { let type: String }
	private struct EntryEvent: Decodable { let entry: Entry }
	private struct SessionEvent: Decodable { let session: SessionSummary }
	private struct DraftEvent: Decodable { let draft: MessageText }
	private struct ToolCallEvent: Decodable { let toolCall: ToolCallItem }

	private func apply(_ data: String) {
		let json = Data(data.utf8)
		let decoder = JSONDecoder()
		guard let kind = try? decoder.decode(Kind.self, from: json) else { return }
		switch kind.type {
		case "entry":
			guard let entry = try? decoder.decode(EntryEvent.self, from: json).entry else { return }
			if let index = entries.firstIndex(where: { $0.id == entry.id }) {
				entries[index] = entry
			} else {
				entries.append(entry)
			}
			if entry.kind == .assistant { draft = nil }
		case "toolCall":
			if let call = try? decoder.decode(ToolCallEvent.self, from: json).toolCall, let note = call.note {
				toolNotes[call.messageId, default: []].append(note)
			}
		case "session":
			if let summary = try? decoder.decode(SessionEvent.self, from: json).session { status = summary.status }
		default:
			break
		}
	}

	private func applyLive(_ data: String) {
		let json = Data(data.utf8)
		guard let kind = try? JSONDecoder().decode(Kind.self, from: json) else { return }
		if kind.type == "draft" {
			draft = try? JSONDecoder().decode(DraftEvent.self, from: json).draft
		} else if kind.type == "draftCleared" {
			draft = nil
		}
	}
}

/// What the phone shows of a record: messages, letters, notices, renew boundaries, and tool runs.
enum Step: Identifiable {
	case user(Entry)
	case letter(Entry, LetterRef)
	case answer(Entry)
	case tools(id: String, names: [String], reviewed: Bool, risky: Bool)
	case renew(Entry)
	case notice(Entry)

	var id: String {
		switch self {
		case .user(let entry), .letter(let entry, _), .answer(let entry), .renew(let entry), .notice(let entry): entry.id
		case .tools(let id, _, _, _): "tools-\(id)"
		}
	}

	static func steps(of entries: [Entry], toolNotes: [String: [PermissionNote]] = [:]) -> [Step] {
		var steps: [Step] = []
		var tools: [String] = []
		var toolsId = ""
		var reviewed = false
		var risky = false
		func flush() {
			if !tools.isEmpty { steps.append(.tools(id: toolsId, names: tools, reviewed: reviewed, risky: risky)) }
			tools = []
			reviewed = false
			risky = false
		}
		for entry in entries {
			switch entry.kind {
			case .assistant:
				if tools.isEmpty { toolsId = entry.id }
				tools += entry.tools
				for note in toolNotes[entry.id] ?? [] {
					if note.reviewed != nil { reviewed = true }
					if let risk = note.risk, !risk.isEmpty { risky = true }
				}
				if !entry.text.isEmpty {
					flush()
					steps.append(.answer(entry))
				}
			case .user:
				flush()
				if let letter = entry.letter {
					steps.append(.letter(entry, letter))
				} else if !entry.text.isEmpty || !entry.attachments.isEmpty {
					steps.append(.user(entry))
				}
			case .renew:
				flush()
				steps.append(.renew(entry))
			case .notice:
				flush()
				if !entry.text.isEmpty { steps.append(.notice(entry)) }
			case .other:
				break
			}
		}
		flush()
		return steps
	}
}

struct StepView: View {
	let step: Step
	var onOpenImage: ((AttachmentRef) -> Void)?

	var body: some View {
		switch step {
		case .user(let entry):
			VStack(alignment: .trailing, spacing: 6) {
				if !entry.attachments.isEmpty {
					EntryAttachmentsView(attachments: entry.attachments, onOpenImage: onOpenImage)
				}
				if !entry.text.isEmpty {
					Text(entry.text)
						.textSelection(.enabled)
						.padding(.horizontal, 14)
						.padding(.vertical, 10)
						.background(.background.secondary, in: RoundedRectangle(cornerRadius: 18))
				}
			}
			.frame(maxWidth: .infinity, alignment: .trailing)
			.padding(.leading, 40)
		case .letter(_, let letter):
			LetterFoldView(letter: letter)
		case .answer(let entry):
			AnswerText(text: entry.text)
		case .tools(_, let names, let reviewed, let risky):
			VStack(alignment: .leading, spacing: 4) {
				Label(ToolSummary.line(names), systemImage: "wrench.and.screwdriver")
					.font(.footnote)
					.foregroundStyle(.secondary)
				if reviewed || risky {
					HStack(spacing: 6) {
						if reviewed { Tag(text: String(localized: "Auto-checked")) }
						if risky { Tag(text: String(localized: "Risky step"), warning: true) }
					}
				}
			}
		case .renew(let entry):
			RenewDividerView(brief: entry.text)
		case .notice(let entry):
			Text(entry.text)
				.font(.footnote)
				.foregroundStyle(.secondary)
				.multilineTextAlignment(.center)
				.frame(maxWidth: .infinity)
		}
	}
}

/// A letter the session received, as one line: who it is from, its kind and its summary. Tapping
/// the line opens the letter under it.
private struct LetterFoldView: View {
	let letter: LetterRef
	@State private var open = false

	private var summary: String {
		letter.summary.isEmpty ? letter.body : letter.summary
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Button {
				open.toggle()
			} label: {
				HStack(spacing: 6) {
					Image(systemName: "envelope")
					Text(LetterKind.line(from: letter.sender, kind: letter.kind))
						.layoutPriority(1)
					Text(summary)
						.foregroundStyle(.tertiary)
					Spacer(minLength: 0)
					Image(systemName: "chevron.right")
						.font(.caption2)
						.rotationEffect(.degrees(open ? 90 : 0))
				}
				.lineLimit(1)
				.font(.footnote)
				.foregroundStyle(.secondary)
				.frame(minHeight: 28)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityValue(open ? Text("Expanded") : Text("Collapsed"))
			if open {
				Text(letter.body)
					.textSelection(.enabled)
					.padding(.leading, 12)
					.overlay(alignment: .leading) {
						Rectangle().fill(Color.yewControl).frame(width: 2)
					}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

private struct RenewDividerView: View {
	let brief: String
	@State private var open = false

	var body: some View {
		VStack(spacing: 6) {
			HStack(spacing: 8) {
				Rectangle().fill(.separator).frame(height: 1)
				Text("Fresh context below")
					.font(.caption2)
					.foregroundStyle(.secondary)
				Rectangle().fill(.separator).frame(height: 1)
			}
			if !brief.isEmpty {
				DisclosureGroup("Carry-over brief", isExpanded: $open) {
					AnswerText(text: brief)
						.font(.footnote)
						.foregroundStyle(.secondary)
						.padding(.top, 4)
				}
				.font(.caption)
			}
		}
		.padding(.vertical, 4)
	}
}

private struct EntryAttachmentsView: View {
	let attachments: [AttachmentRef]
	var onOpenImage: ((AttachmentRef) -> Void)?

	var body: some View {
		let images = attachments.filter { $0.kind == "image" }
		let files = attachments.filter { $0.kind != "image" }
		VStack(alignment: .trailing, spacing: 6) {
			if !images.isEmpty {
				HStack(spacing: 6) {
					ForEach(images) { ref in
						AttachmentThumbnail(attachment: ref) {
							onOpenImage?(ref)
						}
					}
				}
			}
			ForEach(files) { file in
				HStack(spacing: 6) {
					Image(systemName: file.kind == "pdf" ? "doc.richtext" : "doc.text")
						.font(.caption)
					Text(file.name)
						.font(.caption)
						.lineLimit(1)
					if let pages = file.pages {
						Text("\(pages)p")
							.font(.caption2)
							.foregroundStyle(.secondary)
					}
				}
				.padding(.horizontal, 10)
				.padding(.vertical, 6)
				.background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
			}
		}
	}
}

private struct AttachmentThumbnail: View {
	@Environment(AppModel.self) private var model
	let attachment: AttachmentRef
	let tap: () -> Void
	@State private var image: UIImage?

	var body: some View {
		Button(action: tap) {
			Group {
				if let image {
					Image(uiImage: image)
						.resizable()
						.scaledToFill()
				} else {
					ProgressView()
				}
			}
			.frame(width: 96, height: 96)
			.background(.background.secondary)
			.clipShape(RoundedRectangle(cornerRadius: 12))
		}
		.buttonStyle(.plain)
		.task(id: attachment.id) {
			if let data = await model.fetchAttachmentData(id: attachment.id, thumb: true) {
				image = UIImage(data: data)
			}
		}
	}
}

private struct AttachmentLightbox: View {
	@Environment(AppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	let attachment: AttachmentRef
	@State private var image: UIImage?

	var body: some View {
		NavigationStack {
			Group {
				if let image {
					ScrollView([.horizontal, .vertical]) {
						Image(uiImage: image)
							.resizable()
							.scaledToFit()
							.frame(maxWidth: .infinity)
					}
				} else {
					ProgressView()
				}
			}
			.navigationTitle(attachment.name)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
		}
		.task(id: attachment.id) {
			if let data = await model.fetchAttachmentData(id: attachment.id, thumb: false) {
				image = UIImage(data: data)
			}
		}
	}
}

/// An answer's text, with its inline Markdown (bold, code, links) shown as such.
struct AnswerText: View {
	let text: String

	var body: some View {
		Group {
			if let styled = try? AttributedString(
				markdown: text,
				options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
			) {
				Text(styled)
			} else {
				Text(text)
			}
		}
		.textSelection(.enabled)
		.frame(maxWidth: .infinity, alignment: .leading)
	}
}

/// "Ran 2 commands, made 1 edit": the tools a stretch of work used, by kind, in the Mac's wording.
enum ToolSummary {
	static func line(_ names: [String]) -> String {
		var counts: [String: Int] = [:]
		for name in names { counts[kind(of: name), default: 0] += 1 }
		let order = ["read", "edit", "write", "search", "shell", "web", "letter", "session", "card", "other"]
		// "Read 1 file, ran 2 commands": only the first part keeps its capital (Chinese has none).
		return order.compactMap { kind in counts[kind].map { text(kind, $0) } }
			.enumerated()
			.map { index, part in index == 0 ? part : part.prefix(1).lowercased() + part.dropFirst() }
			.joined(separator: String(localized: ", "))
	}

	private static func kind(of tool: String) -> String {
		switch tool {
		case "read", "read_attachment": "read"
		case "edit", "write": tool
		case "grep", "glob": "search"
		case "shell", "shell_job": "shell"
		case "web_fetch": "web"
		case "send_letter": "letter"
		case "open_session": "session"
		case "post_card", "update_card", "withdraw_card": "card"
		default: "other"
		}
	}

	private static func text(_ kind: String, _ n: Int) -> String {
		switch kind {
		case "read": String(localized: "Read \(n) files")
		case "edit": String(localized: "Made \(n) edits")
		case "write": String(localized: "Wrote \(n) files")
		case "search": String(localized: "Searched \(n) times")
		case "shell": String(localized: "Ran \(n) commands")
		case "web": String(localized: "Fetched \(n) pages")
		case "letter": String(localized: "Wrote \(n) letters")
		case "session": String(localized: "Opened \(n) sessions")
		case "card": String(localized: "Changed the approval center \(n) times")
		default: String(localized: "\(n) other steps")
		}
	}
}

/// Who wrote a letter, as the Mac names them: a session by its name, you, the command line, or a
/// scheduled task.
enum Sender {
	static func name(kind: String?, name: String) -> String {
		switch kind {
		case "person": String(localized: "You")
		case "cli": String(localized: "Command line")
		case "yew": String(localized: "Scheduled task “\(name)”")
		default: name
		}
	}
}

/// "Main · Request": who a letter is from and what kind it is, as the Mac's letter cards show it.
enum LetterKind {
	static func line(from name: String, kind: String) -> String {
		"\(name) · \(label(kind))"
	}

	static func label(_ kind: String) -> String {
		switch kind {
		case "request": String(localized: "Request")
		case "report": String(localized: "Report")
		case "decision": String(localized: "Decision")
		default: String(localized: "Notice")
		}
	}
}
