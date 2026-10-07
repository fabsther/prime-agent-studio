package dev.primeagent.fleet

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import org.commonmark.node.*
import org.junit.Assert.*
import org.junit.Test

class MarkdownMessageTest {
    @Test fun commonmarkPreservesBlocksAndUnfinishedStreamingCode() {
        val document = parseMessageMarkdown("# Heading\n\n- First\n- Second\n\n7. Seventh\n\n> Quoted\n\n```kotlin\nval x = 1\n")
        assertTrue(document.firstChild is Heading)
        assertTrue(document.firstChild.next is BulletList)
        val ordered = document.firstChild.next.next as OrderedList
        assertEquals(7, ordered.markerStartNumber)
        assertTrue(ordered.next is BlockQuote)
        assertEquals("val x = 1\n", (ordered.next.next as FencedCodeBlock).literal)
    }

    @Test fun inlineFormattingKeepsNestedStylesAndLiteralCode() {
        val paragraph = parseMessageMarkdown("**bold *italic*** and `a < b`  \nnext").firstChild
        val text = messageInlineText(paragraph, Color.Blue, Color.Gray) {}
        assertEquals("bold italic and a < b\nnext", text.text)
        assertTrue(text.spanStyles.any { it.item.fontWeight == FontWeight.Bold })
        assertTrue(text.spanStyles.any { it.item.fontStyle == FontStyle.Italic })
        assertTrue(text.spanStyles.any { it.item.fontFamily == FontFamily.Monospace && it.item.background == Color.Gray })
    }

    @Test fun linksAreAnnotatedButUnsafeDestinationsStayPlainText() {
        val paragraph = parseMessageMarkdown("[site](https://example.com/docs) [unsafe](javascript:alert) [file](file:///secret)").firstChild
        val text = messageInlineText(paragraph, Color.Blue, Color.Gray) {}
        assertEquals("site unsafe file", text.text)
        val links = text.getLinkAnnotations(0, text.length)
        assertEquals(1, links.size)
        assertEquals("https://example.com/docs", (links.single().item as LinkAnnotation.Url).url)
    }

    @Test fun browserUrlFilterRejectsNonBrowserAndCredentialUrls() {
        assertEquals("https://example.com/path?q=a#top", messageBrowserUrl("https://example.com/path?q=a#top"))
        assertEquals("HTTP://example.com", messageBrowserUrl("HTTP://example.com"))
        listOf("javascript:alert(1)", "intent://example.com", "file:///secret", "data:text/html,x", "mailto:a@example.com",
            "/relative", "//example.com", "https://", "https://a:b@example.com", "https://example.com/a b").forEach {
            assertNull(it, messageBrowserUrl(it))
        }
    }

    @Test fun imagesShowAltTextAndHtmlStaysLiteral() {
        val paragraph = parseMessageMarkdown("![A diagram](https://example.com/image.png) <span>literal</span>").firstChild
        val text = messageInlineText(paragraph, Color.Blue, Color.Gray) {}
        assertEquals("A diagram <span>literal</span>", text.text)
        assertTrue(text.getLinkAnnotations(0, text.length).isEmpty())
    }
}
