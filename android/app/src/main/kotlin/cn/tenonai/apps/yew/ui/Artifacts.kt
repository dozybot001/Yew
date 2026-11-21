package cn.tenonai.apps.yew.ui

import android.annotation.SuppressLint
import android.graphics.Color as AndroidColor
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import cn.tenonai.apps.yew.AppModel
import cn.tenonai.apps.yew.Page
import cn.tenonai.apps.yew.R
import cn.tenonai.apps.yew.api.ArtifactItem
import cn.tenonai.apps.yew.api.ChartData
import java.io.ByteArrayInputStream
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

/** "Chart · Weekly report · Version 2": what kind an artifact is, whose it is, and its version past the first. */
@Composable
private fun artifactLine(artifact: ArtifactItem, session: String): String = listOfNotNull(
    stringResource(
        when (artifact.kind) {
            "html" -> R.string.artifact_page
            "json" -> R.string.artifact_data
            "chart" -> R.string.artifact_chart
            else -> R.string.artifact_document
        },
    ),
    session.ifEmpty { null },
    if (artifact.version > 1) stringResource(R.string.artifact_version, artifact.version) else null,
).joinToString(" · ")

/** What sessions saved for you to look at: documents, pages, data and charts, newest first. */
@Composable
fun ArtifactsList(model: AppModel) {
    Refreshable(model, { model.refreshArtifacts() }) {
        LazyColumn(Modifier.fillMaxSize()) {
            items(model.artifacts, key = { it.id }) { artifact ->
                Column(
                    Modifier.fillMaxWidth().clickable { model.pages.add(Page.Artifact(artifact)) }.padding(16.dp, 10.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(artifact.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(artifactLine(artifact, model.name(artifact.sessionId)), color = colors.soft, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (model.loaded && model.artifacts.isEmpty()) {
                item { Box(Modifier.fillParentMaxSize()) { Empty(Icons.Artifacts, stringResource(R.string.artifacts_empty)) } }
            }
        }
    }
}

private val pretty = Json { prettyPrint = true }

/** One artifact's latest version, drawn by its kind. */
@Composable
fun ArtifactScreen(model: AppModel, artifact: ArtifactItem, close: () -> Unit) {
    var content by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(artifact) {
        val text = model.artifactText(artifact)
        if (text != null) content = text else failed = true
    }
    Screen(artifact.name, onBack = close) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val text = content
            val chart = remember(text) {
                if (artifact.kind != "chart" || text == null) null
                else runCatching { ChartData.from(Json.parseToJsonElement(text).jsonObject) }.getOrNull()
            }
            when {
                text == null && failed -> Unreadable()
                text == null -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = colors.soft)
                artifact.kind == "html" -> SealedPage(text)
                artifact.kind == "chart" -> if (chart != null) {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) { Chart(chart) }
                } else {
                    Unreadable()
                }
                artifact.kind == "markdown" -> SelectionContainer {
                    Text(inlineMarkdown(text), Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp))
                }
                else -> SelectionContainer {
                    val shown = remember(text) {
                        runCatching { pretty.encodeToString(JsonElement.serializer(), Json.parseToJsonElement(text)) }.getOrDefault(text)
                    }
                    Text(
                        shown, fontFamily = Mono, style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                            .horizontalScroll(rememberScrollState()).padding(16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Unreadable() {
    Empty(R.drawable.mascot_lost, stringResource(R.string.artifact_unreadable))
}

/** Bars or lines over labels, in black, white and grey as the rest of Yew: series differ by shade. */
@Composable
private fun Chart(chart: ChartData) {
    val shades = listOf(0.9f, 0.5f, 0.3f, 0.7f, 0.4f, 0.6f, 0.2f, 0.8f).map { colors.ink.copy(alpha = it) }
    val grid = colors.control
    val values = chart.series.flatMap { it.second }
    val top = maxOf(values.maxOrNull() ?: 0.0, 0.0).let { if (it == 0.0) 1.0 else it }
    val bottom = minOf(values.minOrNull() ?: 0.0, 0.0)
    val count = maxOf(chart.labels.size, chart.series.maxOf { it.second.size })
    // What a screen reader says in place of the drawing: each series with its values.
    val spoken = chart.series.joinToString("; ") { (name, numbers) -> "$name: ${numbers.joinToString(", ") { number(it) }}" }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (!chart.title.isNullOrEmpty()) Text(chart.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(number(top), color = colors.soft, style = MaterialTheme.typography.bodySmall)
        }
        Canvas(Modifier.fillMaxWidth().height(240.dp).semantics { contentDescription = spoken }) {
            val slot = size.width / count
            fun y(value: Double) = (size.height * (1 - (value - bottom) / (top - bottom))).toFloat()
            drawLine(grid, Offset(0f, y(0.0)), Offset(size.width, y(0.0)), strokeWidth = 1.dp.toPx())
            drawLine(grid, Offset(0f, 0f), Offset(size.width, 0f), strokeWidth = 1.dp.toPx())
            chart.series.forEachIndexed { index, (_, numbers) ->
                val shade = shades[index % shades.size]
                if (chart.line) {
                    val path = Path()
                    numbers.forEachIndexed { i, value ->
                        val x = slot * (i + 0.5f)
                        if (i == 0) path.moveTo(x, y(value)) else path.lineTo(x, y(value))
                    }
                    drawPath(path, shade, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round))
                    numbers.forEachIndexed { i, value -> drawCircle(shade, 3.dp.toPx(), Offset(slot * (i + 0.5f), y(value))) }
                } else {
                    val width = slot * 0.7f / chart.series.size
                    numbers.forEachIndexed { i, value ->
                        val left = slot * i + slot * 0.15f + width * index
                        val from = y(maxOf(value, 0.0))
                        drawRect(shade, Offset(left, from), Size(width, y(minOf(value, 0.0)) - from))
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth()) {
            for (i in 0 until count) {
                Text(
                    chart.labels.getOrNull(i).orEmpty(), color = colors.soft, style = MaterialTheme.typography.bodySmall,
                    textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Clip, modifier = Modifier.weight(1f),
                )
            }
        }
        if (chart.series.size > 1) {
            chart.series.forEachIndexed { index, (name, _) ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(12.dp).background(shades[index % shades.size]))
                    Text(name, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

private fun number(value: Double): String = if (value == Math.rint(value)) value.toLong().toString() else "%.2f".format(value)

/**
 * An HTML artifact, shut in: it has no address of its own, the web view loads nothing from the
 * network or from files, every request it makes is answered with nothing, links lead nowhere, and a
 * policy in the page stops what is left. Its own scripts can run, but cannot reach Yew, the
 * computer or the network.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun SealedPage(html: String) {
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(AndroidColor.WHITE)
                settings.apply {
                    javaScriptEnabled = true
                    blockNetworkLoads = true
                    blockNetworkImage = true
                    allowFileAccess = false
                    allowContentAccess = false
                    domStorageEnabled = false
                    setGeolocationEnabled(false)
                    setSupportMultipleWindows(false)
                    javaScriptCanOpenWindowsAutomatically = false
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                        if (request.url.scheme == "data" || request.url.scheme == "blob" || request.url.toString() == "about:blank") {
                            null
                        } else {
                            WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                        }
                }
            }
        },
        update = { it.loadDataWithBaseURL(null, SEAL + html, "text/html", "utf-8", null) },
        onRelease = { it.destroy() },
        modifier = Modifier.fillMaxSize(),
    )
}

private const val SEAL =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; img-src data: blob:; font-src data:\">"
