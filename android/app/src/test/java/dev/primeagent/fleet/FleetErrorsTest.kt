package dev.primeagent.fleet

import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test

class FleetErrorsTest {
    private fun response(status: Int, body: String = "", retryAfter: String? = null): Response = Response.Builder()
        .request(Request.Builder().url("https://pc.tailnet.ts.net").build())
        .protocol(Protocol.HTTP_1_1).code(status).message("raw status text must not be displayed")
        .body(body.toResponseBody())
        .apply { retryAfter?.let { header("Retry-After", it) } }.build()

    @Test fun typedExceptionsDoNotLeakRawEnglishMessages() {
        assertEquals(FleetError.Timeout, SocketTimeoutException("raw timeout").toFleetError())
        assertEquals(FleetError.Network, IOException("raw network").toFleetError())
        assertEquals(FleetError.Unknown, IllegalStateException("raw internal English").toFleetError())
        assertEquals(FleetError.InvalidInput, FleetException(FleetError.InvalidInput).toFleetError())
        val composed = "Exécution lancée, lien non enregistré."
        assertEquals(FleetError.Localized(composed), DelegationLinkException(composed, IOException()).toFleetError())
    }

    @Test fun serverDetailsArePreservedOnlyForJsonStrings() {
        val detail = "PIN personnalisé : déjà utilisé — do not translate"
        response(401, """{"error":"$detail"}""").use {
            assertEquals(FleetError.Http(401, detail), httpError(it).error)
        }
        listOf(null, "", "<html>Internal Server Error</html>", "{}", "{bad", "{\"error\":401}",
            "{\"error\":null}", "{\"error\":{\"message\":\"raw\"}}", "{\"error\":\"  \"}").forEach {
            assertNull(serverErrorMessage(it))
        }
    }

    @Test fun httpStatusesRetainTheirCategoryAndRetryPolicy() {
        val expected = mapOf(401 to R.string.fleet_error_http_401, 403 to R.string.fleet_error_http_403,
            404 to R.string.fleet_error_http_404, 409 to R.string.fleet_error_http_409,
            429 to R.string.fleet_error_http_429, 500 to R.string.fleet_error_http_server,
            503 to R.string.fleet_error_http_server, 408 to R.string.fleet_error_timeout,
            418 to R.string.fleet_error_http_other)
        expected.forEach { (status, resource) ->
            response(status).use { assertEquals(resource, httpError(it).error.stringResource()) }
        }
        listOf(408, 429, 500, 503, 599).forEach { assertTrue(FleetError.Http(it).retryable) }
        listOf(301, 401, 403, 404, 409, 499, 600).forEach { assertFalse(FleetError.Http(it).retryable) }
    }

    @Test fun retryAfterSupportsSecondsAndHttpDatesWithoutOverflow() {
        assertEquals(120L, retryAfterSeconds(" 120 "))
        assertEquals(0L, retryAfterSeconds("0"))
        assertEquals(1L, retryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT", 1445412479999L))
        assertEquals(120L, retryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT", 1445412360000L))
        listOf(null, "", "-1", "+1", "1.5", "nonsense", "999999999999999999999999").forEach {
            assertNull(retryAfterSeconds(it))
        }
        assertNull(retryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT", 1445412480001L))
        response(429, """{"error":"Slow down"}""", "60").use {
            assertEquals(FleetError.Http(429, "Slow down", 60), httpError(it).error)
        }
    }

    @Test fun mapperNeverReadsSuccessfulDownloadBodies() {
        response(200, "binary payload").use {
            try { httpError(it); fail("Successful streams are not error responses") }
            catch (_: IllegalArgumentException) { }
            assertEquals("binary payload", it.body!!.string())
        }
    }

    private fun strings(language: String): Map<Int, String> {
        val file = listOf(File("src/main/res/$language/errors.xml"), File("app/src/main/res/$language/errors.xml"))
            .first { it.isFile }
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = document.getElementsByTagName("string")
        val ids = R.string::class.java.fields.associate { it.name to it.getInt(null) }
        return (0 until nodes.length).associate { index ->
            val node = nodes.item(index)
            ids.getValue(node.attributes.getNamedItem("name").nodeValue) to node.textContent.replace("\\n", "\n")
        }
    }

    @Test fun everyErrorHasFrenchDefaultAndEnglishCopyAndPreservesDetails() {
        val errors = listOf(FleetError.InvalidTailscaleUrl, FleetError.IncompatibleIdentity, FleetError.MachineOffline,
            FleetError.EmptyResponse, FleetError.InvalidInput, FleetError.Timeout, FleetError.Network, FleetError.Unknown) +
            listOf(401, 403, 404, 409, 429, 500, 408, 418).map { FleetError.Http(it) } +
            DownloadError.entries.map { FleetError.Download(it) }
        for (language in listOf("values", "values-en")) {
            val table = strings(language)
            val locale = if (language == "values") Locale.FRENCH else Locale.ENGLISH
            val render = { error: FleetError -> error.renderText { resource, arguments -> String.format(locale, table.getValue(resource), *arguments) } }
            errors.forEach { assertTrue(render(it).isNotBlank()) }
            assertTrue(render(FleetError.Network).contains("Tailscale"))
            val detail = "Custom error — ne pas traduire"
            val rendered = render(FleetError.Http(429, detail, 90))
            assertTrue(rendered.contains(detail))
            assertTrue(rendered.contains("90"))
            assertTrue(render(FleetError.Http(418)).contains("418"))
            assertEquals(detail, render(FleetError.Localized(detail)))
            assertFalse(render(IllegalStateException("RAW ENGLISH").toFleetError()).contains("RAW ENGLISH"))
            assertTrue(render(FleetError.Download(DownloadError.INVALID_RANGE)) != render(FleetError.Download(DownloadError.VALIDATOR_CHANGED)))
        }
        assertTrue(strings("values").getValue(R.string.fleet_error_unknown) != strings("values-en").getValue(R.string.fleet_error_unknown))
    }
}
