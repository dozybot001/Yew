package cn.tenonai.apps.yew.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import cn.tenonai.apps.yew.AppModel
import cn.tenonai.apps.yew.Page
import cn.tenonai.apps.yew.R
import cn.tenonai.apps.yew.api.AttachmentRef
import cn.tenonai.apps.yew.api.Entry
import cn.tenonai.apps.yew.api.LetterRef
import cn.tenonai.apps.yew.api.MessageText
import cn.tenonai.apps.yew.api.PermissionNote
import cn.tenonai.apps.yew.api.SessionSummary
import cn.tenonai.apps.yew.api.Step
import cn.tenonai.apps.yew.api.ToolCallItem
import cn.tenonai.apps.yew.api.ToolKinds
import cn.tenonai.apps.yew.api.obj
import cn.tenonai.apps.yew.api.str
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

/** A list that reloads when pulled down. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Refreshable(model: AppModel, reload: suspend () -> Unit, content: @Composable () -> Unit) {
    var refreshing by remember { mutableStateOf(false) }
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            model.go {
                reload()
                refreshing = false
            }
        },
        modifier = Modifier.fillMaxSize(),
    ) { content() }
}

/** All sessions, pinned first, with what each is doing; tap one to read and write in it. */
@Composable
fun SessionsList(model: AppModel) {
    Refreshable(model, { model.refreshAll() }) {
        LazyColumn(Modifier.fillMaxSize()) {
            items(model.orderedSessions, key = { it.id }) { session ->
                SessionRow(session) { model.pages.add(Page.Session(session)) }
            }
            if (model.loaded && model.sessions.isEmpty()) {
                item { Box(Modifier.fillParentMaxSize()) { Empty(Icons.Sessions, stringResource(R.string.sessions_empty)) } }
            }
        }
    }
}

@Composable
private fun SessionRow(session: SessionSummary, open: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = open).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(if (session.cwd == null) Icons.Chat else Icons.Code, null, Modifier.size(22.dp), tint = colors.soft)
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(session.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (session.pinned) Icon(Icons.Pin, stringResource(R.string.pinned), Modifier.size(14.dp), tint = colors.soft)
        }
        StatusMark(session)
    }
}

/** Waiting, working and errors show as a dot; an idle session shows its unread count. */
@Composable
private fun StatusMark(session: SessionSummary) {
    val (color, label) = when (session.status) {
        "waiting" -> colors.waiting to R.string.status_waiting
        "working" -> colors.soft to R.string.status_working
        "error", "needs_review" -> colors.danger to R.string.status_attention
        else -> {
            if (session.unread > 0) {
                val unread = pluralStringResource(R.plurals.unread, session.unread, session.unread)
                Text(
                    "${session.unread}", color = colors.soft, style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { contentDescription = unread },
                )
            }
            return
        }
    }
    val text = stringResource(label)
    Box(Modifier.size(8.dp).background(color, CircleShape).semantics { contentDescription = text })
}

private data class StagedPhoto(
    val id: String,
    val ref: AttachmentRef,
    val preview: ImageBitmap,
)

/**
 * One session: its record, kept current from the computer's event stream, and a field to write to
 * it. While the session works, the answer appears as it is written, and the send button stops it.
 */
@Composable
fun SessionScreen(model: AppModel, session: SessionSummary, close: () -> Unit) {
    val context = LocalContext.current
    var entries by remember { mutableStateOf(listOf<Entry>()) }
    var toolNotes by remember { mutableStateOf(mapOf<String, List<PermissionNote>>()) }
    var status by remember { mutableStateOf(session.status) }
    var draft by remember { mutableStateOf<String?>(null) }
    var loaded by remember { mutableStateOf(false) }
    // Where the part of the record before what is shown ends; null when all of it is shown.
    var older by remember { mutableStateOf<Int?>(null) }
    var loadingOlder by remember { mutableStateOf(false) }
    var message by rememberSaveable { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var staged by remember { mutableStateOf(listOf<StagedPhoto>()) }
    var uploading by remember { mutableStateOf(false) }
    var lightbox by remember { mutableStateOf<AttachmentRef?>(null) }

    val pickPhotos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        uploading = true
        model.go {
            try {
                for (uri in uris) {
                    if (staged.size >= 4) break
                    val compressed = withContext(Dispatchers.IO) { compressImageUri(context, uri) } ?: continue
                    val (jpeg, bitmap) = compressed
                    val name = "photo-${System.currentTimeMillis()}.jpg"
                    val ref = model.uploadAttachment(session.id, name, "image/jpeg", jpeg) ?: continue
                    staged = staged + StagedPhoto(ref.id, ref, bitmap.asImageBitmap())
                }
            } finally {
                uploading = false
            }
        }
    }

    // The field's text as the computer last has it. What is typed is saved there once typing pauses;
    // an emptied field and leaving the screen save at once.
    var kept by remember { mutableStateOf("") }
    LaunchedEffect(session.id, model.client) {
        val text = model.unsent(session.id) ?: return@LaunchedEffect
        if (message.isEmpty()) {
            kept = text
            message = text
        }
    }
    LaunchedEffect(message) {
        if (message == kept) return@LaunchedEffect
        if (message.isNotEmpty()) delay(500)
        val text = message
        kept = text
        model.keepUnsent(text, session.id)
    }
    DisposableEffect(session.id) {
        onDispose {
            val text = message
            if (text != kept) model.go { model.keepUnsent(text, session.id) }
        }
    }

    suspend fun load(): Int? {
        val transcript = model.transcript(session.id) ?: return null
        // Read again after a drop: earlier parts that were already read stay.
        val first = transcript.entries.firstOrNull()?.seq
        val kept = if (first == null) emptyList() else entries.filter { it.seq < first }
        if (kept.isEmpty()) older = transcript.olderCursor
        entries = kept + transcript.entries
        val nextNotes = toolNotes.toMutableMap()
        for (call in transcript.toolCalls) {
            val note = call.note ?: continue
            val current = nextNotes[call.messageId].orEmpty()
            if (note !in current) nextNotes[call.messageId] = current + note
        }
        toolNotes = nextNotes
        status = transcript.session.status
        loaded = true
        return transcript.session.eventSeq
    }

    // Reads the record, then follows the session's events from where it ends; after a drop, reads it
    // again and picks up from there.
    LaunchedEffect(session.id, model.client) {
        while (true) {
            val after = load()
            val client = model.client ?: return@LaunchedEffect
            try {
                client.events(session.id, after).collect { event ->
                    val json = runCatching { Json.parseToJsonElement(event.data).jsonObject }.getOrNull() ?: return@collect
                    when (event.event) {
                        "session" -> when (json.str("type")) {
                            "entry" -> json.obj("entry")?.let(Entry::from)?.let { entry ->
                                entries = if (entries.any { it.id == entry.id }) {
                                    entries.map { if (it.id == entry.id) entry else it }
                                } else {
                                    entries + entry
                                }
                                if (entry.kind == Entry.Kind.Assistant) draft = null
                            }
                            "toolCall" -> json.obj("toolCall")?.let(ToolCallItem::from)?.let { call ->
                                val note = call.note ?: return@let
                                val current = toolNotes[call.messageId].orEmpty()
                                if (note !in current) {
                                    toolNotes = toolNotes + (call.messageId to (current + note))
                                }
                            }
                            "session" -> json.obj("session")?.str("status")?.let { status = it }
                        }
                        "live" -> when (json.str("type")) {
                            "draft" -> draft = MessageText.from(json.obj("draft")).text
                            "draftCleared" -> draft = null
                        }
                        "reset" -> load()
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // The banner on the first screen says what is wrong; here the record just waits.
            }
            delay(3_000)
        }
    }

    val steps = remember(entries, toolNotes) { Step.of(entries, toolNotes) }
    val list = rememberLazyListState()
    val working = status == "working"
    val rows = steps.size + (if (!draft.isNullOrEmpty()) 1 else 0) + (if (working) 1 else 0)
    // New entries at the end bring the end into view; reading an earlier part leaves the view where it is.
    val last = entries.lastOrNull()?.id
    LaunchedEffect(last, working, draft?.length) { if (rows > 0) list.scrollToItem(list.layoutInfo.totalItemsCount - 1, Int.MAX_VALUE / 2) }

    Screen(
        title = session.name,
        onBack = close,
        bottomBar = {
            Composer(
                message = message,
                onChange = { message = it },
                working = working,
                sending = sending,
                uploading = uploading,
                staged = staged,
                onPickPhotos = {
                    pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                onRemovePhoto = { photo ->
                    staged = staged.filterNot { it.id == photo.id }
                    model.go { model.deletePendingAttachment(session.id, photo.id) }
                },
                send = {
                    val text = message.trim()
                    val ids = staged.map { it.id }
                    if (text.isNotEmpty() || ids.isNotEmpty()) {
                        sending = true
                        model.go {
                            if (model.send(text, session.id, ids)) {
                                message = ""
                                staged = emptyList()
                                load()
                            }
                            sending = false
                        }
                    }
                },
                stop = { model.go { model.stop(session.id) } },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (loaded && entries.isEmpty()) Empty(Icons.Chat, stringResource(R.string.messages_empty))
            // Reading the record through the relay can take seconds; the screen says it is on its way.
            if (!loaded) CircularProgressIndicator(Modifier.align(Alignment.Center), color = colors.soft)
            SelectionContainer {
                LazyColumn(
                    state = list,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    val before = older
                    if (before != null) {
                        item(key = "older") {
                            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                CapsuleButton(
                                    stringResource(R.string.messages_older), kind = ButtonKind.Secondary, busy = loadingOlder,
                                    onClick = {
                                        loadingOlder = true
                                        model.go {
                                            model.transcript(session.id, before)?.let { page ->
                                                entries = page.entries + entries
                                                older = page.olderCursor
                                            }
                                            loadingOlder = false
                                        }
                                    },
                                )
                            }
                        }
                    }
                    items(steps, key = { it.id }) { StepView(model, it) { ref -> lightbox = ref } }
                    if (!draft.isNullOrEmpty()) item(key = "draft") { AnswerText(draft.orEmpty()) }
                    if (working) {
                        item(key = "working") {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Icon(Icons.Dots, null, Modifier.size(18.dp), tint = colors.soft)
                                Text(stringResource(R.string.working), color = colors.soft, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }
    }

    lightbox?.let { ref ->
        AttachmentLightbox(model, ref) { lightbox = null }
    }
}

private fun compressImageUri(context: Context, uri: Uri, maxDimension: Int = 2048): Pair<ByteArray, Bitmap>? {
    val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    val decoded = BitmapFactory.decodeByteArray(raw, 0, raw.size) ?: return null
    val longest = maxOf(decoded.width, decoded.height)
    val scaled = if (longest > maxDimension && longest > 0) {
        val ratio = maxDimension.toFloat() / longest.toFloat()
        Bitmap.createScaledBitmap(
            decoded,
            maxOf(1, (decoded.width * ratio).toInt()),
            maxOf(1, (decoded.height * ratio).toInt()),
            true,
        )
    } else {
        decoded
    }
    val out = ByteArrayOutputStream()
    if (!scaled.compress(Bitmap.CompressFormat.JPEG, 85, out)) return null
    return out.toByteArray() to scaled
}

@Composable
private fun Composer(
    message: String,
    onChange: (String) -> Unit,
    working: Boolean,
    sending: Boolean,
    uploading: Boolean,
    staged: List<StagedPhoto>,
    onPickPhotos: () -> Unit,
    onRemovePhoto: (StagedPhoto) -> Unit,
    send: () -> Unit,
    stop: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().background(colors.paper).navigationBarsPadding().imePadding(),
    ) {
        if (staged.isNotEmpty() || uploading) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                staged.forEach { photo ->
                    Box(Modifier.size(60.dp)) {
                        Image(
                            bitmap = photo.preview,
                            contentDescription = photo.ref.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.size(56.dp).align(Alignment.BottomStart).clip(RoundedCornerShape(10.dp)),
                        )
                        val removeDesc = stringResource(R.string.remove_attachment)
                        Surface(
                            onClick = { onRemovePhoto(photo) },
                            shape = CircleShape,
                            color = Color.Black.copy(alpha = 0.7f),
                            contentColor = Color.White,
                            modifier = Modifier.size(20.dp).align(Alignment.TopEnd).semantics { contentDescription = removeDesc },
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                Icon(Icons.Close, null, Modifier.size(12.dp))
                            }
                        }
                    }
                }
                if (uploading) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = colors.soft)
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val attachDesc = stringResource(R.string.attach_photo)
            Surface(
                onClick = onPickPhotos,
                enabled = staged.size < 4 && !uploading && !sending,
                shape = CircleShape,
                color = colors.bubble,
                contentColor = colors.ink,
                modifier = Modifier.size(44.dp).semantics { contentDescription = attachDesc },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Attach, null, Modifier.size(20.dp))
                }
            }
            GrowingField(message, onChange, stringResource(R.string.message_hint), Modifier.weight(1f))
            val stopping = working && message.isBlank() && staged.isEmpty()
            val enabled = stopping || ((message.isNotBlank() || staged.isNotEmpty()) && !sending && !uploading)
            val label = stringResource(if (stopping) R.string.stop else R.string.send)
            Surface(
                onClick = if (stopping) stop else send,
                enabled = enabled,
                shape = CircleShape,
                color = if (enabled) colors.ink else colors.primary,
                contentColor = if (enabled) colors.paper else colors.soft,
                modifier = Modifier.size(48.dp).semantics { contentDescription = label },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(if (stopping) Icons.Stop else Icons.Up, null, Modifier.size(24.dp))
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StepView(model: AppModel, step: Step, onOpenImage: (AttachmentRef) -> Unit) {
    when (step) {
        is Step.User -> Column(
            Modifier.fillMaxWidth().padding(start = 40.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (step.entry.attachments.isNotEmpty()) {
                EntryAttachments(model, step.entry.attachments, onOpenImage)
            }
            if (step.entry.text.isNotEmpty()) {
                Text(
                    step.entry.text,
                    modifier = Modifier.background(colors.bubble, RoundedCornerShape(18.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }
        is Step.Letter -> LetterFold(step.letter)
        is Step.Answer -> AnswerText(step.entry.text)
        is Step.Tools -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Tools, null, Modifier.size(16.dp), tint = colors.soft)
                Text(toolSummary(step.names), color = colors.soft, style = MaterialTheme.typography.bodySmall)
            }
            if (step.reviewed || step.risky) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (step.reviewed) Tag(stringResource(R.string.auto_checked))
                    if (step.risky) Tag(stringResource(R.string.risky_step), warning = true)
                }
            }
        }
        is Step.Renew -> RenewDivider(step.entry.text)
        is Step.Notice -> Text(
            step.entry.text, color = colors.soft, style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * A letter the session received, as one line: who it is from, its kind and its summary. Tapping the
 * line opens the letter under it.
 */
@Composable
private fun LetterFold(letter: LetterRef) {
    var open by remember { mutableStateOf(false) }
    val state = stringResource(if (open) R.string.expanded else R.string.collapsed)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 32.dp).clickable { open = !open }.semantics { stateDescription = state },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Letters, null, Modifier.size(16.dp), tint = colors.soft)
            Text(
                letterLine(senderName(letter.fromKind, letter.fromName), letter.kind),
                color = colors.soft, style = MaterialTheme.typography.bodySmall, maxLines = 1,
            )
            Text(
                letter.summary.ifEmpty { letter.body },
                modifier = Modifier.weight(1f),
                color = colors.soft.copy(alpha = 0.7f), style = MaterialTheme.typography.bodySmall,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Icon(Icons.Forward, null, Modifier.size(14.dp).rotate(if (open) 90f else 0f), tint = colors.soft)
        }
        if (open) {
            Text(letter.body, Modifier.padding(start = 12.dp))
        }
    }
}

@Composable
private fun RenewDivider(brief: String) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            HorizontalDivider(Modifier.weight(1f), color = colors.control)
            Text(stringResource(R.string.renew_divider), color = colors.soft, style = MaterialTheme.typography.labelSmall)
            HorizontalDivider(Modifier.weight(1f), color = colors.control)
        }
        if (brief.isNotEmpty()) {
            Text(
                stringResource(R.string.renew_brief),
                color = colors.soft,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.align(Alignment.CenterHorizontally).clickable { open = !open }.padding(4.dp),
            )
            if (open) {
                Text(inlineMarkdown(brief), color = colors.soft, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun EntryAttachments(model: AppModel, attachments: List<AttachmentRef>, onOpenImage: (AttachmentRef) -> Unit) {
    val images = attachments.filter { it.kind == "image" }
    val files = attachments.filter { it.kind != "image" }
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (images.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                images.forEach { ref ->
                    AttachmentThumbnail(model, ref) { onOpenImage(ref) }
                }
            }
        }
        files.forEach { file ->
            Row(
                Modifier.background(colors.bubble, RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Artifacts, null, Modifier.size(14.dp), tint = colors.soft)
                Text(file.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (file.pages != null) {
                    Text("${file.pages}p", color = colors.soft, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun AttachmentThumbnail(model: AppModel, ref: AttachmentRef, onClick: () -> Unit) {
    var bitmap by remember(ref.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(ref.id) {
        val bytes = model.fetchAttachmentBytes(ref.id, thumb = true) ?: return@LaunchedEffect
        bitmap = withContext(Dispatchers.IO) {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }
    }
    Box(
        Modifier.size(96.dp).clip(RoundedCornerShape(12.dp)).background(colors.bubble).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        val img = bitmap
        if (img != null) {
            Image(img, ref.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = colors.soft)
        }
    }
}

@Composable
private fun AttachmentLightbox(model: AppModel, ref: AttachmentRef, onDismiss: () -> Unit) {
    var bitmap by remember(ref.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(ref.id) {
        val bytes = model.fetchAttachmentBytes(ref.id, thumb = false) ?: return@LaunchedEffect
        bitmap = withContext(Dispatchers.IO) {
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = colors.paper) {
            Column(Modifier.fillMaxSize().navigationBarsPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(ref.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    TextButton(onClick = onDismiss) { Text(stringResource(R.string.done)) }
                }
                Box(Modifier.fillMaxWidth().weight(1f).padding(16.dp), contentAlignment = Alignment.Center) {
                    val img = bitmap
                    if (img != null) {
                        Image(img, ref.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
                    } else {
                        CircularProgressIndicator(color = colors.soft)
                    }
                }
            }
        }
    }
}

/** An answer's text, with its inline Markdown (bold, code, links) shown as such. */
@Composable
private fun AnswerText(text: String) {
    Text(inlineMarkdown(text), modifier = Modifier.fillMaxWidth())
}

/** "Read 1 file, ran 2 commands": the tools a stretch of work used, by kind, in the computer's wording. */
@Composable
private fun toolSummary(names: List<String>): String {
    return ToolKinds.count(names).mapIndexed { index, (kind, n) ->
        val part = pluralStringResource(
            when (kind) {
                "read" -> R.plurals.tools_read
                "edit" -> R.plurals.tools_edit
                "write" -> R.plurals.tools_write
                "search" -> R.plurals.tools_search
                "shell" -> R.plurals.tools_shell
                "web" -> R.plurals.tools_web
                "letter" -> R.plurals.tools_letter
                "session" -> R.plurals.tools_session
                "card" -> R.plurals.tools_card
                else -> R.plurals.tools_other
            },
            n, n,
        )
        // Only the first part keeps its capital (Chinese has none).
        if (index == 0) part else part.replaceFirstChar { it.lowercase() }
    }.joinToString(stringResource(R.string.tools_separator))
}

/** Who wrote a letter, as the computer names them: a session by its name, you, the command line, or a scheduled task. */
@Composable
fun senderName(kind: String?, name: String): String = when (kind) {
    "person" -> stringResource(R.string.sender_you)
    "cli" -> stringResource(R.string.sender_cli)
    "yew" -> stringResource(R.string.sender_schedule, name)
    else -> name
}

/** "Main · Request": who a letter is from and what kind it is. */
@Composable
fun letterLine(from: String, kind: String): String = "$from · " + stringResource(
    when (kind) {
        "request" -> R.string.letter_request
        "report" -> R.string.letter_report
        "decision" -> R.string.letter_decision
        else -> R.string.letter_notice
    },
)

/** Text in a fixed-width face, as commands are shown. */
val Mono = FontFamily.Monospace
