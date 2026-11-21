package cn.tenonai.apps.yew.remote

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.DataFormatException
import java.util.zip.Inflater
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/** Why the relay closed the connection, when it says (src/remote/protocol.ts, relay/relay.ts). */
sealed class RelayException(message: String) : IOException(message) {
    /** The computer is not connected to the relay: asleep, Yew not running, or phone access off. */
    class ComputerOffline : RelayException("The computer is not online.")

    /** The computer closed the channel: it no longer knows this phone. */
    class Refused : RelayException("The computer no longer knows this phone.")

    companion object {
        fun of(code: Int): RelayException? = when (code) {
            4404 -> ComputerOffline()
            1000 -> Refused()
            else -> null
        }
    }
}

/** This end closed the channel (unpairing, or a new connection replacing it). */
class ChannelClosed : IOException("closed")

/** The most an answer may grow to when it is unpacked, as the channel's own limit on a message. */
private const val MAX_UNPACKED = 16 * 1024 * 1024

/**
 * The body of an answer as the computer wrote it. A packed one (`z: 1`, src/remote/protocol.ts) is
 * the UTF-8 text deflated without a zlib header (RFC 1951) and then base64; the computer packs
 * answers of a kilobyte or more when the request asked for it, before they are encrypted.
 */
fun unpackBody(body: String, packed: Boolean): String {
    if (!packed) return body
    val inflater = Inflater(true)
    try {
        inflater.setInput(Base64.getDecoder().decode(body))
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (!inflater.finished()) {
            val n = inflater.inflate(buffer)
            if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) throw IOException("a packed answer is cut short")
            out.write(buffer, 0, n)
            if (out.size() > MAX_UNPACKED) throw IOException("a packed answer is too large")
        }
        return out.toString("UTF-8")
    } catch (error: DataFormatException) {
        throw IOException(error)
    } catch (error: IllegalArgumentException) {
        throw IOException(error)
    } finally {
        inflater.end()
    }
}

/** An answer with a status outside 200–299 to a request that was meant to stream. */
class StreamRefused(val status: Int, val body: String) : IOException("HTTP $status")

class Welcome(val desktop: String, val version: String, val device: String)

/** The sockets of the app: pings keep a quiet connection open and show a dead one within a minute. */
val relayHttp: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
}

/**
 * The phone's end of the encrypted channel to the computer, through the relay: a Noise IK handshake
 * with the computer's key from the pairing, then the same requests the web interface sends to the
 * computer's local API, encrypted end to end. It reconnects on the next request after a drop.
 */
class RelayChannel(
    private val pairing: Pairing,
    private val key: ByteArray,
    private val deviceName: String,
    private val appVersion: String,
    private val http: OkHttpClient = relayHttp,
) {
    /** One connection: its socket and the two directions. Replaced as a whole on reconnect. */
    private class Live(val socket: WebSocket, val send: NoiseCipher, val opener: NoiseOpener)

    private val connecting = Mutex()
    @Volatile private var live: Live? = null
    private val nextId = AtomicInteger(1)
    private val waiting = ConcurrentHashMap<Int, CompletableDeferred<Pair<String, Int>>>()
    private val streams = ConcurrentHashMap<Int, Channel<String>>()

    /** Shakes hands with the computer; [pairSecret] is the QR code's secret when this phone is not paired yet. */
    suspend fun connect(pairSecret: String? = null): Welcome = connecting.withLock {
        close()
        val initiator = NoiseInitiator(key, pairing.desktopKey, "yew-remote/1:${pairing.desktop}".toByteArray())
        val hello = buildJsonObject {
            if (pairSecret != null) put("pair", pairSecret)
            put("name", deviceName)
            put("app", appVersion)
        }
        val answer = CompletableDeferred<ByteArray>()
        var mine: Live? = null
        val listener = object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val current = mine
                if (current == null) {
                    answer.complete(bytes.toByteArray())
                    return
                }
                try {
                    // OkHttp reads one message at a time, so the opener is never used by two threads.
                    current.opener.open(bytes.toByteArray())?.let(::deliver)
                } catch (error: NoiseException) {
                    webSocket.cancel()
                    dropped(webSocket, error)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                dropped(webSocket, RelayException.of(code) ?: IOException("closed with $code"))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                dropped(webSocket, if (t is IOException) t else IOException(t))
            }

            private fun dropped(webSocket: WebSocket, error: Exception) {
                answer.completeExceptionally(error)
                if (live?.socket === webSocket) drop(error)
            }
        }
        // The relay address comes from the QR code; a ws:// one is refused by the platform in release builds.
        val url = "${pairing.relay.trimEnd('/')}/phone/${pairing.desktop}"
            .replaceFirst("wss://", "https://").replaceFirst("ws://", "http://")
        val socket = try {
            http.newWebSocket(Request.Builder().url(url).build(), listener)
        } catch (error: IllegalArgumentException) {
            throw IOException(error)
        }
        try {
            // OkHttp queues this until the socket is open.
            socket.send(initiator.writeFirst(hello.toString().toByteArray()).toByteString())
            val session = initiator.readSecond(withTimeout(20_000) { answer.await() })
            val fields = Json.parseToJsonElement(session.payload.toString(Charsets.UTF_8)).jsonObject
            val welcome = Welcome(
                desktop = fields["desktop"]?.jsonPrimitive?.content.orEmpty(),
                version = fields["version"]?.jsonPrimitive?.content.orEmpty(),
                device = fields["device"]?.jsonPrimitive?.content.orEmpty(),
            )
            val connected = Live(socket, session.send, NoiseOpener(session.receive))
            live = connected
            mine = connected
            welcome
        } catch (error: Throwable) {
            socket.cancel()
            throw if (error is NoiseException) IOException(error) else error
        }
    }

    private suspend fun connected(): Live = live ?: run {
        connect()
        live ?: throw IOException("not connected")
    }

    private fun send(to: Live, message: String) {
        // Sealing and queueing happen together, so messages leave in the order their nonces were taken.
        synchronized(to) {
            for (part in noiseSeal(to.send, message.toByteArray())) {
                if (!to.socket.send(part.toByteString())) throw IOException("the connection is closed")
            }
        }
    }

    /**
     * One request to the computer's local API; the body and status come back as the computer answered.
     * Cancelling the caller gives up on the answer.
     */
    suspend fun request(method: String, path: String, body: String?): Pair<String, Int> {
        val to = connected()
        val id = nextId.getAndIncrement()
        val answer = CompletableDeferred<Pair<String, Int>>()
        waiting[id] = answer
        try {
            send(to, buildJsonObject {
                put("t", "req")
                put("id", id)
                put("method", method)
                put("path", path)
                if (body != null) put("body", body)
                // Asks for a compressed answer; a computer that does not know this ignores it.
                put("z", 1)
            }.toString())
            // The connection may have dropped between the lookup and the send being registered.
            if (live !== to) answer.completeExceptionally(IOException("the connection dropped"))
            return answer.await()
        } finally {
            waiting.remove(id)
        }
    }

    /** A streamed request (the event stream): text as it comes, until the computer ends it or the collector stops. */
    fun stream(path: String): Flow<String> = flow {
        val to = connected()
        val id = nextId.getAndIncrement()
        val pieces = Channel<String>(Channel.UNLIMITED)
        streams[id] = pieces
        try {
            send(to, buildJsonObject {
                put("t", "req")
                put("id", id)
                put("method", "GET")
                put("path", path)
            }.toString())
            if (live !== to) pieces.close(IOException("the connection dropped"))
            for (piece in pieces) emit(piece)
        } finally {
            // Still listed means the computer has not ended it: tell it to stop sending.
            if (streams.remove(id) != null && live === to) {
                runCatching { send(to, buildJsonObject { put("t", "cancel"); put("id", id) }.toString()) }
            }
        }
    }

    private fun deliver(message: ByteArray) {
        val reply = runCatching { Json.parseToJsonElement(message.toString(Charsets.UTF_8)).jsonObject }.getOrNull()
            ?: return
        val id = reply["id"]?.jsonPrimitive?.int ?: return
        when (reply["t"]?.jsonPrimitive?.content) {
            "res" -> {
                val status = reply["status"]?.jsonPrimitive?.int ?: 0
                val packed = reply["z"]?.jsonPrimitive?.intOrNull == 1
                val body = try {
                    unpackBody(reply["body"]?.jsonPrimitive?.content.orEmpty(), packed)
                } catch (error: IOException) {
                    waiting.remove(id)?.completeExceptionally(error)
                    return
                }
                waiting.remove(id)?.complete(body to status)
                // A stream the computer refused (404, 403) comes back as a plain answer.
                streams.remove(id)?.close(StreamRefused(status, body))
            }
            "chunk" -> streams[id]?.trySend(reply["data"]?.jsonPrimitive?.content.orEmpty())
            "end" -> streams.remove(id)?.close()
        }
    }

    private fun drop(error: Exception) {
        live = null
        for (id in waiting.keys.toList()) waiting.remove(id)?.completeExceptionally(error)
        for (id in streams.keys.toList()) streams.remove(id)?.close(error)
    }

    fun close() {
        val current = live ?: return
        drop(ChannelClosed())
        current.socket.close(1001, null)
    }
}
