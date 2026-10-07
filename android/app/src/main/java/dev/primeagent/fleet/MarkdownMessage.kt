package dev.primeagent.fleet

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import org.commonmark.node.*
import org.commonmark.node.Text as MarkdownText
import org.commonmark.parser.Parser
import java.net.URI

private val markdownParser = Parser.builder().build()

/** Native, selectable CommonMark. Images show alt text; HTML is literal, never executed. */
@Composable
fun MarkdownMessage(markdown: String, modifier: Modifier = Modifier) {
    val document = remember(markdown) { parseMessageMarkdown(markdown) }
    SelectionContainer(modifier) {
        MarkdownBlocks(document)
    }
}

internal fun parseMessageMarkdown(markdown: String): Node = markdownParser.parse(markdown)

private fun Node.children(): Sequence<Node> = generateSequence(firstChild) { it.next }

@Composable
private fun MarkdownBlocks(parent: Node, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        parent.children().forEach { block ->
            when (block) {
                is Paragraph -> MarkdownInline(block)
                is Heading -> {
                    val typography = MaterialTheme.typography
                    val style = when (block.level) {
                        1 -> typography.headlineSmall
                        2 -> typography.titleLarge
                        3 -> typography.titleMedium
                        4 -> typography.titleSmall
                        5 -> typography.labelLarge
                        else -> typography.labelMedium
                    }
                    MarkdownInline(block, style.copy(fontWeight = FontWeight.SemiBold), Modifier.semantics { heading() })
                }
                is FencedCodeBlock -> MarkdownCode(block.literal)
                is IndentedCodeBlock -> MarkdownCode(block.literal)
                is BulletList -> MarkdownList(block)
                is OrderedList -> MarkdownList(block, block.markerStartNumber ?: 1)
                is BlockQuote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant))
                    MarkdownBlocks(block, Modifier.weight(1f).padding(start = 12.dp))
                }
                is ThematicBreak -> HorizontalDivider()
                is HtmlBlock -> Text(block.literal.trimEnd(), style = MaterialTheme.typography.bodyMedium)
                else -> MarkdownBlocks(block)
            }
        }
    }
}

@Composable
private fun MarkdownList(list: Node, start: Int? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        list.children().forEachIndexed { index, item ->
            Row(Modifier.fillMaxWidth()) {
                Text(
                    text = if (start == null) "•" else "${start + index}.",
                    modifier = Modifier.widthIn(min = 24.dp).padding(end = 8.dp),
                    style = MaterialTheme.typography.bodyMedium
                )
                MarkdownBlocks(item, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun MarkdownCode(code: String) {
    Box(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialTheme.shapes.small)) {
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(12.dp)) {
            Text(
                text = code.removeSuffix("\n"),
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                softWrap = false
            )
        }
    }
}

@Composable
private fun MarkdownInline(
    node: Node,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    modifier: Modifier = Modifier
) {
    val colors = MaterialTheme.colorScheme
    val uriHandler = LocalUriHandler.current
    val text = remember(node, colors.primary, colors.surfaceContainerHighest, uriHandler) {
        messageInlineText(node, colors.primary, colors.surfaceContainerHighest) { url ->
            // A missing browser must not crash the conversation.
            runCatching { uriHandler.openUri(url) }
        }
    }
    Text(text = text, modifier = modifier, style = style)
}

/** Only browser URLs from message text are actionable; no intents, file URLs or credentials. */
internal fun messageBrowserUrl(destination: String): String? = runCatching {
    val uri = URI(destination)
    destination.takeIf {
        (uri.scheme.equals("https", ignoreCase = true) || uri.scheme.equals("http", ignoreCase = true)) &&
            !uri.host.isNullOrBlank() && uri.rawUserInfo == null
    }
}.getOrNull()

internal fun messageInlineText(
    parent: Node,
    linkColor: Color,
    codeBackground: Color,
    openUrl: (String) -> Unit
): AnnotatedString = buildAnnotatedString {
    fun appendChildren(node: Node) {
        node.children().forEach { child ->
            when (child) {
                is MarkdownText -> append(child.literal)
                is SoftLineBreak -> append(" ")
                is HardLineBreak -> append("\n")
                is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(child.literal) }
                is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { appendChildren(child) }
                is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendChildren(child) }
                is Link -> {
                    val url = messageBrowserUrl(child.destination)
                    if (url == null) appendChildren(child)
                    else withLink(LinkAnnotation.Url(
                        url = url,
                        styles = TextLinkStyles(style = SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)),
                        linkInteractionListener = { openUrl(url) }
                    )) { appendChildren(child) }
                }
                is HtmlInline -> append(child.literal)
                // No remote image fetches, HTML interpretation or custom URL schemes.
                else -> appendChildren(child)
            }
        }
    }
    appendChildren(parent)
}
