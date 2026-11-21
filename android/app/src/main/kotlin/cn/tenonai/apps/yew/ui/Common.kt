package cn.tenonai.apps.yew.ui

import android.text.format.DateUtils
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.tenonai.apps.yew.R
import cn.tenonai.apps.yew.api.Choice
import cn.tenonai.apps.yew.api.InlineKind
import cn.tenonai.apps.yew.api.inlinePieces

/** A screen with a title bar: Back at the left when it was opened over another, actions at the right. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Screen(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.semantics { heading() },
                    )
                },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) { Icon(Icons.Back, stringResource(R.string.back)) }
                    }
                },
                actions = actions,
                colors = TopAppBarDefaults.topAppBarColors(containerColor = colors.paper, scrolledContainerColor = colors.paper),
            )
        },
        bottomBar = bottomBar,
        containerColor = colors.paper,
        content = content,
    )
}

/**
 * The full lockup for the first screen and the About page: the mark and the wordmark with a smaller
 * "Harness" after it (the product's name is Yew Harness), measured from the wordmark size [size]
 * (S; the wordmark's drawable is one em, so S high). The mark fills an S square .3S before the
 * wordmark, centred on it; "Harness" is .64S type .25S after the wordmark, on its baseline (.16S
 * above the bottom of its box). No Tenon mark: that appears only with "Tenon AI", where the
 * publisher is named.
 */
@Composable
fun Lockup(size: Dp = 40.dp) {
    val label = stringResource(R.string.lockup_label)
    val harness = with(LocalDensity.current) { (size * 0.64f).toSp() }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.clearAndSetSemantics { contentDescription = label },
    ) {
        Image(painterResource(R.drawable.yew_mark), null, Modifier.size(size))
        Spacer(Modifier.width(size * 0.3f))
        Row {
            Image(
                painterResource(R.drawable.yew_wordmark), null,
                Modifier.size(size * 2.091f, size).alignBy { it.measuredHeight * 84 / 100 },
            )
            Spacer(Modifier.width(size * 0.25f))
            Text(
                "Harness",
                color = colorResource(R.color.mark_ink),
                fontSize = harness,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                softWrap = false,
                modifier = Modifier.alignByBaseline(),
            )
        }
    }
}

/**
 * Yew's mascot in one pose (res/drawable-nodpi/mascot_*.webp). Every pose is drawn on the same
 * 373 by 400 canvas, so one can take another's place without moving anything. She is decoration:
 * screen readers skip her, and she is never put over a control.
 */
@Composable
fun Mascot(@DrawableRes pose: Int, height: Dp, modifier: Modifier = Modifier) {
    Image(painterResource(pose), null, modifier.size(height * (373f / 400f), height))
}

/** A small label with a border, such as "Recommended" or "Can't be undone". */
@Composable
fun Tag(text: String, warning: Boolean = false) {
    val color = if (warning) colors.danger else colors.soft
    Text(
        text, color = color, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium,
        modifier = Modifier
            .border(1.dp, if (warning) colors.danger else colors.control, RoundedCornerShape(5.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

enum class ButtonKind { Primary, Secondary, Destructive }

/**
 * Yew's buttons, as on the computer: the main one on a soft grey fill, the others outlined. At least
 * 48dp high; while [busy] it shows that and takes no second tap.
 */
@Composable
fun CapsuleButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.Primary,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    val foreground = when (kind) {
        ButtonKind.Primary -> colors.onPrimary
        ButtonKind.Secondary -> colors.ink
        ButtonKind.Destructive -> colors.danger
    }
    Surface(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = CircleShape,
        color = if (kind == ButtonKind.Primary) colors.primary else Color.Transparent,
        contentColor = foreground.copy(alpha = if (enabled && !busy) 1f else 0.45f),
        border = if (kind == ButtonKind.Primary) null else BorderStroke(1.dp, colors.control),
        modifier = modifier.defaultMinSize(minHeight = 48.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            if (icon != null) {
                Icon(icon, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(if (busy) "$text…" else text, fontWeight = FontWeight.Medium, maxLines = 1)
        }
    }
}

/** A section's heading in a list. */
@Composable
fun SectionTitle(text: String) {
    Text(
        text, color = colors.soft, style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
    )
}

/** A note under a group of rows, in smaller grey text. */
@Composable
fun Footnote(text: String) {
    Text(
        text, color = colors.soft, style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

/** A group of rows inside one outline, as the settings and About pages use. */
@Composable
fun Group(content: @Composable () -> Unit) {
    Column(
        Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp))
            .border(1.dp, colors.control, RoundedCornerShape(14.dp)),
    ) { content() }
}

/** One row of a group: a label and its value, and where a tap leads when it leads somewhere. */
@Composable
fun GroupRow(label: String, value: String? = null, onClick: (() -> Unit)? = null, leading: (@Composable () -> Unit)? = null, color: Color = colors.ink) {
    Row(
        Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = color, modifier = if (value == null && leading == null) Modifier.weight(1f) else Modifier)
        if (value != null || leading != null) {
            Spacer(Modifier.width(12.dp))
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                leading?.invoke()
                if (value != null) Text(value, color = colors.soft, textAlign = TextAlign.End)
            }
        }
        if (onClick != null && value == null && leading == null && color == colors.ink) Icon(Icons.Forward, null, Modifier.size(18.dp), tint = colors.soft)
    }
}

@Composable
fun GroupDivider() {
    Box(Modifier.fillMaxWidth().padding(start = 16.dp).background(colors.control).heightIn(min = 1.dp, max = 1.dp))
}

/** What a list shows when it is loaded and has nothing. */
@Composable
fun Empty(icon: ImageVector, text: String) = EmptyWith(text) { Icon(icon, null, Modifier.size(40.dp), tint = colors.soft) }

/** The same with the mascot in a pose that fits in place of the icon. */
@Composable
fun Empty(@DrawableRes mascot: Int, text: String) = EmptyWith(text) { Mascot(mascot, 112.dp) }

@Composable
private fun EmptyWith(text: String, picture: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        picture()
        Spacer(Modifier.size(12.dp))
        Text(text, color = colors.soft, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
    }
}

/** A card's top line and its one sentence: who waits, since when, and on what. */
@Composable
fun CardHead(session: String, date: Double, text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        val since = DateUtils.getRelativeTimeSpanString(
            date.toLong(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE,
        ).toString()
        Text(
            if (session.isEmpty()) since else "$session · $since",
            color = colors.soft, style = MaterialTheme.typography.bodySmall,
        )
        Text(text, maxLines = 4, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * One option to pick: a round mark (or a square one when several may be picked), the label, what it
 * leads to, and the recommended tag.
 */
@Composable
fun OptionRow(option: Choice, recommended: Boolean, selected: Boolean, multiple: Boolean, pick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .selectable(selected = selected, role = if (multiple) Role.Checkbox else Role.RadioButton, onClick = pick)
            .heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(
            when {
                multiple && selected -> Icons.BoxOn
                multiple -> Icons.BoxOff
                selected -> Icons.RadioOn
                else -> Icons.RadioOff
            },
            null, Modifier.padding(top = 1.dp).size(22.dp), tint = if (selected) colors.ink else colors.soft,
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(option.label, modifier = Modifier.weight(1f, fill = false))
                if (recommended) Tag(stringResource(R.string.recommended))
            }
            if (option.detail != null) Text(option.detail, color = colors.soft, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** A text field that grows with its text, on Yew's grey fill. */
@Composable
fun GrowingField(
    value: String,
    onValueChange: (String) -> Unit,
    hint: String,
    modifier: Modifier = Modifier,
    maxLines: Int = 6,
    plain: Boolean = false,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        maxLines = maxLines,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.ink),
        cursorBrush = SolidColor(colors.ink),
        keyboardOptions = if (plain) {
            KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
        } else {
            KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)
        },
        modifier = modifier.defaultMinSize(minHeight = 48.dp).background(colors.bubble, RoundedCornerShape(20.dp)),
        decorationBox = { field ->
            Box(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(hint, color = colors.soft, style = MaterialTheme.typography.bodyLarge)
                field()
            }
        },
    )
}

/**
 * Text with its inline Markdown shown as such: `code`, **bold** and [links](https://…). Anything
 * else stays as written. Worked out once per text, not on every redraw.
 */
@Composable
fun inlineMarkdown(text: String): AnnotatedString {
    val codeBackground = colors.bubble
    return remember(text, codeBackground) {
        val code = SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)
        val bold = SpanStyle(fontWeight = FontWeight.SemiBold)
        val link = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline))
        buildAnnotatedString {
            for (piece in inlinePieces(text)) {
                when (piece.kind) {
                    InlineKind.Plain -> append(piece.text)
                    InlineKind.Code -> withStyle(code) { append(piece.text) }
                    InlineKind.Bold -> withStyle(bold) { append(piece.text) }
                    InlineKind.Link -> withLink(LinkAnnotation.Url(piece.url.orEmpty(), link)) { append(piece.text) }
                }
            }
        }
    }
}

/** The default text style of the content colour, for places that need one as a value. */
@Composable
fun bodyStyle(): TextStyle = MaterialTheme.typography.bodyLarge.copy(color = LocalContentColor.current)
