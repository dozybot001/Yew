package cn.tenonai.apps.yew

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.provider.Settings
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import cn.tenonai.apps.yew.api.ApprovalItem
import cn.tenonai.apps.yew.api.ArtifactItem
import cn.tenonai.apps.yew.api.AttachmentRef
import cn.tenonai.apps.yew.api.CardItem
import cn.tenonai.apps.yew.api.Center
import cn.tenonai.apps.yew.api.DemoTransport
import cn.tenonai.apps.yew.api.YewClient
import cn.tenonai.apps.yew.api.YewProblem
import cn.tenonai.apps.yew.api.LetterItem
import cn.tenonai.apps.yew.api.RelayTransport
import cn.tenonai.apps.yew.api.SessionSummary
import cn.tenonai.apps.yew.api.Transcript
import cn.tenonai.apps.yew.api.objects
import cn.tenonai.apps.yew.api.str
import cn.tenonai.apps.yew.data.Vault
import cn.tenonai.apps.yew.notify.LinkService
import cn.tenonai.apps.yew.notify.Notifier
import cn.tenonai.apps.yew.notify.StartReceiver
import cn.tenonai.apps.yew.remote.ChannelClosed
import cn.tenonai.apps.yew.remote.Pairing
import cn.tenonai.apps.yew.remote.PairingLink
import cn.tenonai.apps.yew.remote.RelayChannel
import cn.tenonai.apps.yew.remote.RelayException
import cn.tenonai.apps.yew.remote.StreamRefused
import cn.tenonai.apps.yew.update.ReleaseCheck
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** How many entries of a session's record the phone reads at a time. */
const val TRANSCRIPT_PAGE = 30

/** How the connection to the computer is doing, for the banner and the settings screen. */
enum class Link {
    Connecting,
    Online,
    /** The relay answers, but the computer is not connected to it. */
    ComputerOffline,
    /** The computer refused this phone: it was removed there. */
    Refused,
    /** The relay cannot be reached. */
    Unreachable,
}

enum class Tab { Sessions, Approvals, Letters, Artifacts }

/** A screen opened over the tabs (or over the first screen); Back closes the last one. */
sealed interface Page {
    data class Session(val session: SessionSummary) : Page
    class Question(val approval: ApprovalItem) : Page
    class Decision(val card: CardItem) : Page
    class Letter(val letter: LetterItem) : Page
    data class Artifact(val artifact: ArtifactItem) : Page
    data object Settings : Page
    data object About : Page
    data class Policy(val privacy: Boolean) : Page
    data object Licenses : Page
    data object Scanner : Page
}

enum class Decision(val value: String) { AllowOnce("allow_once"), AllowAlways("allow_always"), Deny("deny") }

class Answer(val choices: List<Int>, val text: String?)

/**
 * What the app knows about the Yew it is connected to, and the actions the screens take. One for the
 * whole process: the screens and the connection service share it. Used on the main thread only.
 */
class AppModel(private val context: Context) {
    private val scope = MainScope()
    private val vault = Vault(context)
    val notifier = Notifier(context)
    /** New versions on Gitee, checked once a day unless turned off. */
    val releases = ReleaseCheck(context)
    /** A newer version than this app, when one was found; the About page links to it. */
    var newVersion by mutableStateOf(releases.newer)
        private set

    var client by mutableStateOf<YewClient?>(null)
        private set
    private var channel: RelayChannel? = null
    var sessions by mutableStateOf(listOf<SessionSummary>())
        private set
    var center by mutableStateOf<Center?>(null)
        private set
    var letters by mutableStateOf(listOf<LetterItem>())
        private set
    var artifacts by mutableStateOf(listOf<ArtifactItem>())
        private set
    /** The computer this phone is paired with, as the computer names itself. */
    var desktopName by mutableStateOf<String?>(null)
        private set
    var link by mutableStateOf(Link.Connecting)
        private set
    /** Sample data instead of a computer: a first look without pairing. */
    var isDemo by mutableStateOf(false)
        private set
    /** What the computer said when it refused a request, shown to the person. */
    var problem by mutableStateOf<String?>(null)
    var tab by mutableStateOf(Tab.Sessions)
    val pages = mutableStateListOf<Page>()
    /** Just paired: the screen asks Android for permission to show notifications, once. */
    var askForNotifications by mutableStateOf(false)
    /** The notification stream is open: the computer reaches this phone now. */
    var listening by mutableStateOf(false)
        private set

    /** The session to open once the list has it: from a tapped notification. */
    private var sessionToOpen: String? = null
    private var eventsJob: Job? = null
    private var notesJob: Job? = null
    private var visible = false
    /** Completed when the network comes back, so a wait between tries ends early. */
    private var networkBack = CompletableDeferred<Unit>()

    init {
        checkReleases()
        vault.pairing?.let { pairing ->
            use(newChannel(pairing))
            desktopName = pairing.desktopName
        }
        context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    networkBack.complete(Unit)
                }
            },
        )
    }

    val connected: Boolean get() = client != null

    /** Paired with a computer through the relay: not the demo. */
    val paired: Boolean get() = !isDemo && channel != null

    /** The lists hold what the computer has, so an empty one means there is nothing (not that it can't be reached). */
    val loaded: Boolean get() = isDemo || link == Link.Online

    /** Sessions in the order the computer's sidebar shows them: pinned first, then the rest. */
    val orderedSessions: List<SessionSummary> get() = sessions.filter { it.pinned } + sessions.filterNot { it.pinned }

    fun name(sessionId: String?): String = sessions.firstOrNull { it.id == sessionId }?.name.orEmpty()

    private fun newChannel(pairing: Pairing): RelayChannel {
        val name = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
            ?: "${Build.MANUFACTURER} ${Build.MODEL}"
        return RelayChannel(pairing, vault.phoneKey(), name.take(60), BuildConfig.VERSION_NAME)
    }

    private fun use(channel: RelayChannel) {
        this.channel = channel
        client = YewClient(RelayTransport(channel))
    }

    /** Asks Gitee for a new version when a day has passed since the last time. */
    fun checkReleases() {
        scope.launch {
            releases.checkIfDue()
            newVersion = releases.newer
        }
    }

    /** Turns the daily check on or off; on, it checks at once if a day has passed. */
    fun setReleaseChecks(on: Boolean) {
        releases.enabled = on
        if (on) checkReleases()
    }

    /** Runs an action of a screen to its end, even when that screen closes meanwhile. */
    fun go(action: suspend () -> Unit): Job = scope.launch { action() }

    /** A pairing is under way: the buttons that start one wait. */
    var pairing by mutableStateOf(false)
        private set

    fun startPairing(text: String) {
        if (pairing) return
        pairing = true
        scope.launch {
            try {
                pair(text)
            } finally {
                pairing = false
            }
        }
    }

    /** Pairs with the computer whose QR code (or its link) this is: handshake with its secret, then keep it. */
    private suspend fun pair(text: String) {
        val link = PairingLink.parse(text.trim())
        if (link == null) {
            problem = context.getString(R.string.not_pairing_link)
            return
        }
        var pairing = Pairing(link.relay, link.desktop, link.key, link.name, null)
        val channel = newChannel(pairing)
        try {
            val welcome = channel.connect(pairSecret = link.secret)
            pairing = pairing.copy(desktopName = welcome.desktop, deviceId = welcome.device)
            vault.pairing = pairing
            desktopName = welcome.desktop
            use(channel)
            this.link = Link.Online
            problem = null
            pages.clear()
            askForNotifications = true
            follow()
            syncService()
        } catch (error: CancellationException) {
            throw error
        } catch (_: RelayException.ComputerOffline) {
            problem = context.getString(R.string.pair_offline)
        } catch (_: Exception) {
            channel.close()
            problem = context.getString(R.string.pair_failed)
        }
    }

    /**
     * Unpairs: the computer removes this phone from its list when it can be reached, and the phone
     * forgets the pairing and its key either way.
     */
    suspend fun unpair() {
        val client = client
        val id = vault.pairing?.deviceId
        if (client != null && id != null) {
            // The computer closes this phone's channel as it removes it, so no answer comes back; and
            // an offline computer is not waited for long.
            withTimeoutOrNull(5_000) { runCatching { client.delete("/api/devices/$id") } }
        }
        channel?.close()
        vault.forget()
        notifier.forget()
        reset()
        syncService()
    }

    fun startDemo() {
        reset()
        isDemo = true
        desktopName = context.getString(R.string.demo_computer)
        client = YewClient(DemoTransport { context.getString(it) })
        link = Link.Online
        follow()
    }

    fun leaveDemo() = reset()

    private fun reset() {
        eventsJob?.cancel()
        eventsJob = null
        notesJob?.cancel()
        notesJob = null
        listening = false
        channel = null
        client = null
        isDemo = false
        desktopName = null
        link = Link.Connecting
        sessions = emptyList()
        center = null
        letters = emptyList()
        artifacts = emptyList()
        sessionToOpen = null
        problem = null
        tab = Tab.Sessions
        pages.clear()
    }

    // The screens

    /** The app came to the front or left it: the lists follow the computer only while someone looks. */
    fun shown(visible: Boolean) {
        this.visible = visible
        if (visible) follow() else {
            eventsJob?.cancel()
            eventsJob = null
        }
    }

    private fun follow() {
        if (!visible || client == null || eventsJob?.isActive == true) return
        eventsJob = scope.launch {
            refreshAll()
            followEvents()
        }
    }

    suspend fun refreshAll() {
        refreshSessions()
        refreshCenter()
        refreshLetters()
        refreshArtifacts()
    }

    suspend fun refreshArtifacts() {
        attempt { artifacts = it.get("/api/artifacts?limit=200").objects("items").mapNotNull(ArtifactItem::from) }
    }

    /** The text of an artifact's latest version, as the session saved it. */
    suspend fun artifactText(artifact: ArtifactItem): String? {
        var result: String? = null
        attempt { result = it.text("/api/artifacts/${artifact.id}/versions/${artifact.version}") }
        return result
    }

    suspend fun refreshSessions() {
        attempt { sessions = it.get("/api/sessions?limit=200").objects("items").mapNotNull(SessionSummary::from) }
        val wanted = sessionToOpen ?: return
        val session = sessions.firstOrNull { it.id == wanted } ?: return
        sessionToOpen = null
        tab = Tab.Sessions
        pages.clear()
        pages.add(Page.Session(session))
    }

    suspend fun refreshCenter() {
        attempt { center = Center.from(it.get("/api/center")) }
        if (paired) center?.let(notifier::waiting)
    }

    suspend fun refreshLetters() {
        attempt { letters = it.get("/api/letters?limit=100").objects("items").mapNotNull(LetterItem::from) }
    }

    /** A notification was tapped: its session, or the approval center. */
    fun open(session: String?) {
        if (!connected) return
        pages.clear()
        if (session == null) {
            tab = Tab.Approvals
            return
        }
        sessionToOpen = session
        scope.launch { refreshSessions() }
    }

    /**
     * The latest part of a session's record, or the part before [before]. A page is small because
     * the whole of it crosses the relay before anything shows; older parts are read when asked for.
     */
    suspend fun transcript(sessionId: String, before: Int? = null): Transcript? {
        var result: Transcript? = null
        val older = if (before != null) "&before=$before" else ""
        attempt { result = Transcript.from(it.get("/api/sessions/$sessionId/transcript?limit=$TRANSCRIPT_PAGE$older")) }
        return result
    }

    private val attachmentCache = LinkedHashMap<String, ByteArray>(32, 0.75f, true)

    suspend fun send(text: String, sessionId: String, attachmentIds: List<String> = emptyList()): Boolean {
        var sent = false
        attempt {
            it.post("/api/sessions/$sessionId/messages", buildJsonObject {
                put("text", text)
                if (attachmentIds.isNotEmpty()) {
                    putJsonArray("attachments") {
                        for (id in attachmentIds) add(kotlinx.serialization.json.JsonPrimitive(id))
                    }
                }
            })
            sent = true
        }
        return sent
    }

    suspend fun uploadAttachment(sessionId: String, name: String, mimeType: String, bytes: ByteArray): AttachmentRef? {
        var uploaded: AttachmentRef? = null
        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
        attempt {
            val raw = it.post("/api/sessions/$sessionId/attachments", buildJsonObject {
                put("name", name)
                put("mimeType", mimeType)
                put("data", encoded)
            })
            val obj = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull()
            if (obj != null) uploaded = AttachmentRef.from(obj)
        }
        return uploaded
    }

    suspend fun deletePendingAttachment(sessionId: String, attachmentId: String) {
        runCatching { client?.delete("/api/sessions/$sessionId/attachments/$attachmentId") }
    }

    suspend fun fetchAttachmentBytes(id: String, thumb: Boolean): ByteArray? {
        val key = "$id:${if (thumb) "t" else "f"}"
        attachmentCache[key]?.let { return it }
        val active = client ?: return null
        val path = if (thumb) "/api/attachments/$id?thumb=1&format=json" else "/api/attachments/$id?format=json"
        val json = runCatching { active.get(path) }.getOrNull() ?: return null
        val b64 = json.str("data") ?: return null
        val decoded = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() ?: return null
        if (attachmentCache.size > 60) {
            attachmentCache.keys.firstOrNull()?.let(attachmentCache::remove)
        }
        attachmentCache[key] = decoded
        return decoded
    }

    /** What was typed to a session and not sent, as the computer keeps it; null when it could not be read. */
    suspend fun unsent(sessionId: String): String? =
        runCatching { client?.get("/api/unsent/$sessionId")?.str("text") }.getOrNull()

    /** Keeps what is in a session's message field on the computer, so it is there on every device. */
    suspend fun keepUnsent(text: String, sessionId: String) {
        runCatching { client?.put("/api/unsent/$sessionId", buildJsonObject { put("text", text) }) }
    }

    /** Stops what the session is doing; your next message sets it going again. */
    suspend fun stop(sessionId: String) {
        attempt { it.post("/api/sessions/$sessionId/stop") }
    }

    /** Answers a permission request: allow once, always allow this kind, or decline. */
    suspend fun answer(approvalId: String, decision: Decision, confirmedWarning: Boolean = false) {
        attempt {
            it.post("/api/approvals/$approvalId", buildJsonObject {
                put("decision", decision.value)
                if (confirmedWarning) put("confirmedWarning", true)
            })
        }
        refreshCenter()
    }

    /** Answers a question card: the options picked and the person's own words, per question. */
    suspend fun answer(approvalId: String, answers: List<Answer>): Boolean {
        var done = false
        attempt {
            it.post("/api/approvals/$approvalId", buildJsonObject {
                putJsonArray("answers") {
                    for (answer in answers) add(buildJsonObject {
                        put("choices", buildJsonArray { for (choice in answer.choices) add(kotlinx.serialization.json.JsonPrimitive(choice)) })
                        if (answer.text != null) put("text", answer.text)
                    })
                }
            })
            done = true
        }
        refreshCenter()
        return done
    }

    /** Sends the person's decision on a card; it goes back to the sessions that asked. */
    suspend fun decide(cardId: String, choice: Int?, note: String?): Boolean {
        var done = false
        attempt {
            it.post("/api/cards/$cardId/decide", buildJsonObject {
                if (choice != null) put("choice", choice)
                if (note != null) put("note", note)
            })
            done = true
        }
        refreshCenter()
        return done
    }

    /** Releases a held letter to its recipient, or refuses it. */
    suspend fun settle(letterId: String, release: Boolean) {
        attempt { it.post("/api/letters/$letterId/${if (release) "release" else "refuse"}") }
        refreshCenter()
        refreshLetters()
    }

    /**
     * Follows the computer's event stream and refreshes what changed, so the lists stay current.
     * After a drop it tries again, less often while the computer is offline, and reloads once it is back.
     */
    private suspend fun followEvents() {
        var reconnecting = false
        while (scope.isActive) {
            val client = client ?: return
            try {
                client.events().collect { event ->
                    when (event.event) {
                        "hello" -> {
                            link = Link.Online
                            if (reconnecting) refreshAll()
                            reconnecting = true
                        }
                        "reset" -> refreshAll()
                        "global" -> changed(event.data)
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                note(error)
            }
            reconnecting = true
            pause(if (link == Link.Online) 2_000 else 8_000)
        }
    }

    private suspend fun changed(data: String) {
        val type = runCatching { Json.parseToJsonElement(data).jsonObject.str("type") }.getOrNull()
        when (type) {
            "sessionSummary", "groups", "sessionsDeleted" -> refreshSessions()
            "approval", "card" -> refreshCenter()
            "letter" -> {
                refreshCenter()
                refreshLetters()
            }
            "artifact", "artifactDeleted" -> refreshArtifacts()
        }
    }

    /** Runs a request; a refusal from the computer is shown to the person, a lost connection goes to the banner. */
    private suspend fun attempt(work: suspend (YewClient) -> Unit) {
        val client = client ?: return
        try {
            work(client)
            link = Link.Online
        } catch (error: CancellationException) {
            throw error
        } catch (refusal: YewProblem) {
            link = Link.Online
            problem = refusal.message
        } catch (error: Exception) {
            note(error)
        }
    }

    private fun note(error: Exception) {
        if (client == null) return
        link = when (error) {
            is RelayException.ComputerOffline -> Link.ComputerOffline
            is RelayException.Refused -> Link.Refused
            is ChannelClosed -> return
            else -> Link.Unreachable
        }
    }

    /** Waits before the next try; a network that comes back ends the wait early. */
    private suspend fun pause(ms: Long) {
        if (networkBack.isCompleted) networkBack = CompletableDeferred()
        withTimeoutOrNull(ms) { networkBack.await() }
        delay(300)
    }

    // Notifications: the app keeps its own connection to the relay

    /** Whether this phone should be listening for notifications now. */
    val wantsNotes: Boolean get() = paired && notifier.wanted && notifier.allowed

    /**
     * Whether Android may start Yew by itself (after the phone starts, after an update): only when
     * the person chose to keep receiving after Yew is closed. Otherwise the receiver is disabled, so
     * the system has nothing of Yew's to start.
     */
    fun applyKeep() {
        val state = if (notifier.keepAfterClose) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        } else {
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        }
        context.packageManager.setComponentEnabledSetting(
            ComponentName(context, StartReceiver::class.java),
            state,
            PackageManager.DONT_KILL_APP,
        )
    }

    /**
     * Yew was closed (swiped away) and is not to keep receiving: nothing listens any more and the
     * connection to the computer is closed, so a process the system leaves around for a while holds
     * no connection. Opening Yew again connects again.
     */
    fun closed() {
        listen(false)
        eventsJob?.cancel()
        eventsJob = null
        channel?.close()
        notifier.clearStanding()
    }

    /** Starts or stops the connection service to match the pairing, the person's switch and Android's permission. */
    fun syncService() {
        applyKeep()
        val service = Intent(context, LinkService::class.java)
        if (wantsNotes) {
            // Android refuses to start it from the background in some states; the next time the app is opened it starts.
            runCatching { context.startForegroundService(service) }
        } else {
            context.stopService(service)
            // A standing notification left behind by an earlier version or a killed process.
            notifier.clearStanding()
        }
    }

    /**
     * Listens on `GET /api/notes` while the connection service runs: what the computer decides to
     * tell this phone arrives here and is shown as a notification. After a drop it tries again, at
     * most once a minute while the computer cannot be reached.
     */
    fun listen(on: Boolean) {
        if (!on) {
            notesJob?.cancel()
            notesJob = null
            listening = false
            return
        }
        if (notesJob?.isActive == true) return
        notesJob = scope.launch {
            var wait = 3_000L
            var refusals = 0
            while (isActive) {
                val client = client ?: return@launch
                try {
                    coroutineScope {
                        var told = false
                        client.sse("/api/notes").collect { event ->
                            when (event.event) {
                                "hello" -> {
                                    listening = true
                                    link = Link.Online
                                    wait = 3_000L
                                    refusals = 0
                                    told = false
                                    // Back after being away. The computer sends again what it could not
                                    // deliver in the last ten minutes; what is older and still waiting
                                    // gets one notification that sums it up, unless Yew is on screen.
                                    launch {
                                        delay(8_000)
                                        readCenter(client)?.let { notifier.waiting(it, back = !told && !visible) }
                                    }
                                }
                                "note" -> {
                                    told = true
                                    notifier.handle(event.data)
                                    if (!visible) readCenter(client)?.let(notifier::waiting)
                                }
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: StreamRefused) {
                    // A computer whose Yew has no notification stream yet: ask again later.
                    wait = 60_000L
                } catch (error: Exception) {
                    note(error)
                    if (error is RelayException.Refused) refusals += 1
                }
                listening = false
                // Removed on the computer: after a few refusals in a row there is nothing to listen
                // to until the phone is paired again, and the service stops.
                if (refusals >= 3) {
                    context.stopService(Intent(context, LinkService::class.java))
                    return@launch
                }
                pause(wait)
                wait = (wait * 2).coerceAtMost(60_000L)
            }
        }
    }

    private suspend fun readCenter(client: YewClient): Center? =
        runCatching { Center.from(client.get("/api/center")) }.getOrNull()?.also { center = it }
}
