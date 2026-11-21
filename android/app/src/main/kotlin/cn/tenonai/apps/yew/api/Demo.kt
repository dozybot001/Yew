package cn.tenonai.apps.yew.api

import cn.tenonai.apps.yew.R
import java.util.UUID
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * Sample data for a first look without a computer: the requests the app sends to Yew, answered here
 * in the same shapes. What you do in the demo changes only the demo.
 */
class DemoTransport(text: (Int) -> String) : Transport {
    private val server = DemoServer(text)

    override suspend fun send(method: String, path: String, body: String?): Pair<String, Int> =
        synchronized(server) { server.handle(method, path, body) }

    /**
     * The demo changes only when you act, and the screens reload after each action, so its event
     * stream only says hello.
     */
    override fun stream(path: String): Flow<String> = flow {
        emit("event: hello\ndata: {}\n\n")
        awaitCancellation()
    }
}

private class DemoServer(private val text: (Int) -> String) {
    private var seq = 0
    private val sessions = mutableListOf<JsonObject>()
    private val entries = mutableMapOf<String, MutableList<JsonObject>>()
    private val approvals = mutableListOf<JsonObject>()
    private val cards = mutableListOf<JsonObject>()
    private val letters = mutableListOf<JsonObject>()
    private val artifacts = mutableListOf<JsonObject>()
    private val artifactTexts = mutableMapOf<String, String>()

    private fun ago(minutes: Int): Double = (System.currentTimeMillis() - minutes * 60_000L).toDouble()

    private fun session(id: String, name: String, kind: String = "standing", cwd: String? = null, status: String, pinned: Boolean = false) =
        buildJsonObject {
            put("id", id); put("name", name); put("kind", kind); put("cwd", cwd); put("status", status)
            put("pinned", pinned); put("unread", 0); put("groupId", JsonNull); put("parentId", JsonNull); put("eventSeq", 0)
        }

    private fun entry(role: String, minutes: Int, fields: JsonObjectBuilder.() -> Unit): JsonObject {
        seq += 1
        return buildJsonObject {
            put("id", "e$seq"); put("seq", seq); put("role", role); put("createdAt", ago(minutes))
            fields()
        }
    }

    private fun user(words: String, minutes: Int) = entry("user", minutes) {
        putJsonObject("message") { put("role", "user"); put("content", words) }
    }

    private fun assistant(words: String = "", tools: List<String> = emptyList(), minutes: Int) = entry("assistant", minutes) {
        putJsonObject("message") {
            put("role", "assistant")
            putJsonArray("content") {
                for (tool in tools) add(buildJsonObject {
                    put("type", "toolCall"); put("id", UUID.randomUUID().toString()); put("name", tool)
                    putJsonObject("arguments") {}
                })
                if (words.isNotEmpty()) add(buildJsonObject { put("type", "text"); put("text", words) })
            }
        }
    }

    private fun letterEntry(from: String, kind: String, body: String, minutes: Int) = entry("user", minutes) {
        putJsonObject("message") { put("role", "user"); put("content", body) }
        putJsonObject("letter") {
            put("id", "l2"); put("kind", kind); put("summary", body); put("body", body)
            putJsonObject("from") { put("kind", "session"); put("sessionId", "main"); put("name", from) }
        }
    }

    private fun letter(id: String, from: String, to: String, kind: String, status: String, summary: String, minutes: Int) =
        buildJsonObject {
            put("id", id); put("fromName", from); put("toSession", to); put("kind", kind); put("summary", summary)
            put("body", summary); put("status", status); put("statusReason", JsonNull); put("createdAt", ago(minutes))
        }

    private fun option(label: Int, detail: Int) = buildJsonObject { put("label", text(label)); put("detail", text(detail)) }

    init {
        val main = text(R.string.demo_main)
        val store = text(R.string.demo_store)
        val design = text(R.string.demo_design)
        val report = text(R.string.demo_report)
        sessions += session("main", main, status = "idle", pinned = true)
        sessions += session("website", store, cwd = "~/Projects/website", status = "waiting")
        sessions += session("design", design, status = "waiting")
        sessions += session("report", report, kind = "task", status = "working")
        entries["main"] = mutableListOf(
            user(text(R.string.demo_main_ask), 40),
            assistant(text(R.string.demo_main_answer), minutes = 39),
        )
        entries["website"] = mutableListOf(
            user(text(R.string.demo_store_ask), 25),
            assistant(tools = listOf("read", "grep", "edit"), minutes = 24),
            assistant(tools = listOf("shell", "shell"), minutes = 22),
            assistant(text(R.string.demo_store_answer), minutes = 21),
        )
        entries["design"] = mutableListOf(
            letterEntry(main, "request", text(R.string.demo_design_request), 15),
            assistant(tools = listOf("read", "web_fetch", "write"), minutes = 12),
            assistant(text(R.string.demo_design_answer), minutes = 10),
        )
        entries["report"] = mutableListOf(
            letterEntry(main, "request", text(R.string.demo_report_request), 6),
            assistant(tools = listOf("shell", "shell", "read"), minutes = 4),
        )
        approvals += buildJsonObject {
            put("id", "push"); put("sessionId", "website"); put("kind", "permission"); put("createdAt", ago(21))
            putJsonObject("request") {
                put("tool", "shell"); put("summary", "git push origin main")
                put("description", text(R.string.demo_push_description)); put("mustConfirm", true)
            }
        }
        approvals += buildJsonObject {
            put("id", "color"); put("sessionId", "design"); put("kind", "question"); put("createdAt", ago(10))
            putJsonObject("request") {
                putJsonArray("questions") {
                    add(buildJsonObject {
                        put("header", text(R.string.demo_color_header))
                        put("question", text(R.string.demo_color_question))
                        put("options", buildJsonArray {
                            add(option(R.string.demo_color_grey, R.string.demo_color_grey_detail))
                            add(option(R.string.demo_color_accent, R.string.demo_color_accent_detail))
                        })
                        put("recommended", 0)
                    })
                }
            }
        }
        cards += buildJsonObject {
            put("id", "release"); put("number", 12); put("createdAt", ago(30)); put("requestedBy", "website")
            put("createdBy", "main"); put("undoable", true)
            put("title", text(R.string.demo_card_title)); put("context", text(R.string.demo_card_context))
            put("options", buildJsonArray {
                add(option(R.string.demo_card_friday, R.string.demo_card_friday_detail))
                add(option(R.string.demo_card_monday, R.string.demo_card_monday_detail))
            })
            put("recommended", 1)
        }
        letters += letter("held", report, "website", "request", "held", text(R.string.demo_letter_held), 5)
        letters += letter("l3", design, "main", "report", "delivered", text(R.string.demo_letter_report), 10)
        letters += letter("l2", main, "design", "request", "delivered", text(R.string.demo_design_request), 15)
        letters += letter("l1", main, "report", "request", "delivered", text(R.string.demo_report_request), 6)
        val chartTitle = text(R.string.demo_chart_title)
        artifacts += buildJsonObject {
            put("id", "a1"); put("sessionId", "report"); put("name", text(R.string.demo_report_title))
            put("kind", "markdown"); put("version", 2); put("updatedAt", ago(5))
        }
        artifacts += buildJsonObject {
            put("id", "a2"); put("sessionId", "report"); put("name", chartTitle)
            put("kind", "chart"); put("version", 1); put("updatedAt", ago(10))
        }
        artifactTexts["a1"] = text(R.string.demo_report_text)
        artifactTexts["a2"] = buildJsonObject {
            put("type", "bar"); put("title", chartTitle)
            putJsonArray("labels") { for (day in 1..5) add(JsonPrimitive("$day")) }
            putJsonArray("series") {
                add(buildJsonObject {
                    put("name", store)
                    putJsonArray("values") { for (n in listOf(3, 5, 2, 6, 4)) add(JsonPrimitive(n)) }
                })
            }
        }.toString()
    }

    fun handle(method: String, path: String, body: String?): Pair<String, Int> {
        val parts = path.substringBefore("?").split("/").filter { it.isNotEmpty() }
        val fields = body?.let { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() } ?: JsonObject(emptyMap())
        fun at(index: Int) = parts.getOrNull(index)
        return when {
            method == "GET" && parts.size == 2 && at(1) == "sessions" -> page(sessions)
            method == "GET" && parts.size == 4 && at(1) == "sessions" && at(3) == "transcript" -> {
                val session = sessions.find { it.str("id") == at(2) } ?: return missing()
                json(buildJsonObject {
                    put("session", session)
                    put("entries", JsonArray(entries[at(2)].orEmpty()))
                })
            }
            method == "GET" && parts.size == 2 && at(1) == "center" -> json(buildJsonObject {
                put("approvals", JsonArray(approvals))
                put("cards", JsonArray(cards))
                put("held", JsonArray(letters.filter { it.str("status") == "held" }))
            })
            method == "GET" && parts.size == 2 && at(1) == "letters" -> page(letters)
            method == "GET" && parts.size == 2 && at(1) == "artifacts" -> page(artifacts)
            method == "GET" && parts.size == 5 && at(1) == "artifacts" && at(3) == "versions" ->
                artifactTexts[at(2)]?.let { it to 200 } ?: missing()
            method == "POST" && parts.size == 3 && at(1) == "approvals" -> {
                val approval = approvals.find { it.str("id") == at(2) } ?: return missing()
                approvals.remove(approval)
                val sessionId = approval.str("sessionId").orEmpty()
                if (approval.str("kind") == "permission") {
                    val allowed = fields.str("decision") != "deny"
                    append(assistant(text(if (allowed) R.string.demo_pushed else R.string.demo_not_pushed), minutes = 0), sessionId)
                }
                setStatus("idle", sessionId)
                json(JsonObject(emptyMap()))
            }
            method == "POST" && parts.size == 4 && at(1) == "cards" && at(3) == "decide" -> {
                cards.removeAll { it.str("id") == at(2) }
                json(JsonObject(emptyMap()))
            }
            method == "POST" && parts.size == 4 && at(1) == "letters" -> {
                val index = letters.indexOfFirst { it.str("id") == at(2) }
                if (index < 0) return missing()
                letters[index] = JsonObject(letters[index] + ("status" to JsonPrimitive(if (at(3) == "release") "delivered" else "refused")))
                json(JsonObject(emptyMap()))
            }
            method == "POST" && parts.size == 4 && at(1) == "sessions" && at(3) == "messages" -> {
                val id = at(2).orEmpty()
                append(user(fields.str("text").orEmpty(), 0), id)
                append(assistant(text(R.string.demo_reply), minutes = 0), id)
                setStatus("idle", id)
                json(JsonObject(emptyMap()), 201)
            }
            method == "POST" && parts.size == 4 && at(1) == "sessions" && at(3) == "stop" -> {
                setStatus("idle", at(2).orEmpty())
                "" to 204
            }
            else -> missing()
        }
    }

    private fun page(items: List<JsonObject>) = json(buildJsonObject { put("items", JsonArray(items)); put("nextCursor", JsonNull) })

    private fun json(value: JsonObject, status: Int = 200) = value.toString() to status

    private fun missing() = json(buildJsonObject { put("title", "Not Found"); put("status", 404) }, 404)

    private fun append(entry: JsonObject, sessionId: String) {
        entries.getOrPut(sessionId) { mutableListOf() }.add(entry)
        change(sessionId, "eventSeq", JsonPrimitive(seq))
    }

    private fun setStatus(status: String, sessionId: String) = change(sessionId, "status", JsonPrimitive(status))

    private fun change(sessionId: String, field: String, value: JsonPrimitive) {
        val index = sessions.indexOfFirst { it.str("id") == sessionId }
        if (index >= 0) sessions[index] = JsonObject(sessions[index] + (field to value))
    }
}
