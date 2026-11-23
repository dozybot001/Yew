package cn.tenonai.apps.yew.api

import cn.tenonai.apps.yew.remote.RelayChannel
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** Where the app's requests go: the relay channel, or the demo's sample data. */
interface Transport {
    suspend fun send(method: String, path: String, body: String?): Pair<String, Int>

    /** A streamed response, such as the event stream, as text in the pieces it arrives in. */
    fun stream(path: String): Flow<String>
}

/**
 * Requests through the relay channel. A request the computer does not answer within 30 seconds fails,
 * so a stalled connection never leaves a screen waiting.
 */
class RelayTransport(private val channel: RelayChannel) : Transport {
    override suspend fun send(method: String, path: String, body: String?): Pair<String, Int> =
        withTimeoutOrNull(30_000) { channel.request(method, path, body) } ?: throw IOException("timed out")

    override fun stream(path: String): Flow<String> = channel.stream(path)
}

/** An RFC 9457 problem from Yew, shown to the person as it came. */
class YewProblem(val title: String, val detail: String?) : Exception(detail ?: title)

class SseEvent(val event: String, val data: String)

/** Cuts an event stream's text into events, whatever pieces it arrives in. Comments and empty events are skipped. */
class SseParser {
    private val buffer = StringBuilder()

    fun feed(piece: String): List<SseEvent> {
        buffer.append(piece)
        val events = mutableListOf<SseEvent>()
        while (true) {
            val end = buffer.indexOf("\n\n")
            if (end < 0) break
            val block = buffer.substring(0, end)
            buffer.delete(0, end + 2)
            var name = "message"
            val data = mutableListOf<String>()
            for (line in block.split("\n")) {
                if (line.startsWith("event:")) name = line.substring(6).trim()
                if (line.startsWith("data:")) data.add(line.substring(5).trim())
            }
            if (data.isNotEmpty()) events.add(SseEvent(name, data.joinToString("\n")))
        }
        return events
    }
}

class YewClient(val transport: Transport) {
    /**
     * The computer's event stream: one name and data per event, as the web interface reads them. With
     * a session it also carries that session's record; [after] replays what came after that sequence number.
     */
    fun events(session: String? = null, after: Int? = null): Flow<SseEvent> {
        var path = "/api/events"
        if (session != null) {
            path += "?session=$session"
            if (after != null) path += "&after=$after"
        }
        return sse(path)
    }

    /** Any of the computer's event streams, by path. */
    fun sse(path: String): Flow<SseEvent> = flow {
        val parser = SseParser()
        transport.stream(path).collect { piece -> for (event in parser.feed(piece)) emit(event) }
    }

    suspend fun get(path: String): JsonObject = parse(call("GET", path, null))

    /** An answer that is plain text, such as one version of an artifact. */
    suspend fun text(path: String): String = call("GET", path, null)

    suspend fun post(path: String, payload: JsonElement = JsonObject(emptyMap())): String =
        call("POST", path, payload.toString())

    suspend fun patch(path: String, payload: JsonElement): String = call("PATCH", path, payload.toString())

    suspend fun put(path: String, payload: JsonElement): String = call("PUT", path, payload.toString())

    suspend fun delete(path: String) {
        call("DELETE", path, null)
    }

    private suspend fun call(method: String, path: String, body: String?): String {
        val (data, status) = transport.send(method, path, body)
        if (status !in 200..299) {
            val problem = runCatching { parse(data) }.getOrNull()
            throw YewProblem(
                title = problem?.str("title") ?: "HTTP $status",
                detail = problem?.str("detail"),
            )
        }
        return data
    }

    private fun parse(text: String): JsonObject =
        (Json.parseToJsonElement(text).takeIf { it !is JsonNull } ?: JsonObject(emptyMap())).jsonObject
}
