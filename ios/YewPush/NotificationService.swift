import Foundation
@preconcurrency import UserNotifications

/// Runs when a notification arrives: decrypts what the Mac sealed for this phone and shows that
/// instead of the fixed line Apple's service carried.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
	private var deliver: ((UNNotificationContent) -> Void)?
	private var content: UNMutableNotificationContent?

	override func didReceive(
		_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
	) {
		deliver = contentHandler
		content = request.content.mutableCopy() as? UNMutableNotificationContent
		guard let content, let note = PushNote(userInfo: request.content.userInfo), note.clear == nil else {
			contentHandler(request.content)
			return
		}
		let text = PushText(note)
		content.title = text.title
		content.body = text.body
		if let badge = note.badge { content.badge = NSNumber(value: badge) }
		// What the app needs when the notification is tapped or taken away; never the sealed text.
		var info: [AnyHashable: Any] = [:]
		if let id = note.id { info["yew.id"] = id }
		if let session = note.session { info["yew.session"] = session }
		content.userInfo = info
		content.threadIdentifier = note.session ?? "center"
		contentHandler(content)
	}

	override func serviceExtensionTimeWillExpire() {
		if let deliver, let content { deliver(content) }
	}
}

/// A notification's words: the session or item as the title, what happened as the body.
struct PushText {
	let title: String
	let body: String

	init(_ note: PushNote) {
		let detail = note.body ?? ""
		let label: String
		switch note.kind {
		case "permission": label = String(localized: "push.permission")
		case "question": label = String(localized: "push.question")
		case "card": label = String(localized: "push.card")
		case "letter": label = String(localized: "push.letter")
		case "error": label = String(localized: "push.error")
		case "review": label = String(localized: "push.review")
		case "task":
			switch note.code {
			case "given_up": label = String(localized: "push.task.given_up")
			case "failed": label = String(localized: "push.task.failed")
			default: label = String(localized: "push.task.done")
			}
		case "schedule":
			label = note.code == "error" ? String(localized: "push.schedule.error") : String(localized: "push.schedule.done")
		case "budget":
			label = note.code == "budget-reached"
				? String(localized: "push.budget.reached") : String(localized: "push.budget.warning")
		case "many": label = String(localized: "push.many \(note.n ?? 0)")
		default: label = String(localized: "push.fallback")
		}
		let name = note.title ?? ""
		title = name.isEmpty ? "Yew Harness" : name
		body = detail.isEmpty ? label : label + String(localized: "push.separator") + detail
	}
}
