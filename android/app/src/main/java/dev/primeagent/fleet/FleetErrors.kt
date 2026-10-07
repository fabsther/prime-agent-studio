package dev.primeagent.fleet

import android.content.Context
import java.io.IOException
import java.net.SocketTimeoutException
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Response

/** App-owned failures are translated at the UI boundary, never from exception messages. */
sealed interface FleetError {
    data object InvalidTailscaleUrl : FleetError
    data object IncompatibleIdentity : FleetError
    data object MachineOffline : FleetError
    data object EmptyResponse : FleetError
    data object InvalidInput : FleetError
    data object Timeout : FleetError
    data object Network : FleetError
    data object Unknown : FleetError
    data class Localized(val message: String) : FleetError
    data class Http(
        val status: Int,
        val serverMessage: String? = null,
        val retryAfterSeconds: Long? = null,
    ) : FleetError {
        val retryable: Boolean get() = status == 408 || status == 429 || status in 500..599
    }
    data class Download(val reason: DownloadError) : FleetError
}

enum class DownloadError {
    INVALID_LOCAL_SIZE, INVALID_LENGTH, INVALID_RANGE, RANGE_MISMATCH,
    VALIDATOR_CHANGED, LENGTH_MISMATCH, TOO_LARGE, INVALID_RESPONSE,
    STORAGE_PERMISSION, MACHINE_MISSING, STORAGE, INTERRUPTED,
}

class FleetException(val error: FleetError, cause: Throwable? = null) : Exception(null, cause)

fun Throwable.toFleetError(): FleetError = when (this) {
    is FleetException -> error
    is DelegationLinkException -> FleetError.Localized(message.orEmpty())
    is SocketTimeoutException -> FleetError.Timeout
    is IOException -> FleetError.Network
    else -> FleetError.Unknown
}

/** Invalid and past Retry-After values are ignored; dates use the HTTP RFC 1123 form. */
internal fun retryAfterSeconds(value: String?, nowMillis: Long = System.currentTimeMillis()): Long? {
    val raw = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    if (raw.all { it in '0'..'9' }) return raw.toLongOrNull()
    val deadline = try {
        ZonedDateTime.parse(raw, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
    } catch (_: Exception) { return null }
    if (deadline < nowMillis) return null
    val remaining = deadline - nowMillis
    return remaining / 1000 + if (remaining % 1000 == 0L) 0 else 1
}

/** Only server JSON strings are trusted as display text; HTML and raw exception text are not. */
internal fun serverErrorMessage(body: String?): String? = try {
    val value = (Json.parseToJsonElement(body.orEmpty()) as? JsonObject)?.get("error") as? JsonPrimitive
    value?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
} catch (_: Exception) { null }

/** Call only for a failed response. The bounded body read leaves successful streams untouched. */
fun httpError(response: Response): FleetException {
    require(!response.isSuccessful)
    val message = try {
        serverErrorMessage(response.peekBody(64 * 1024).string())
    } catch (_: IOException) { null }
    // Consume/close only the unsuccessful response body.
    response.body?.close()
    return FleetException(FleetError.Http(response.code, message, retryAfterSeconds(response.header("Retry-After"))))
}

internal fun FleetError.stringResource(): Int = when (this) {
    FleetError.InvalidTailscaleUrl -> R.string.fleet_error_invalid_url
    FleetError.IncompatibleIdentity -> R.string.fleet_error_identity
    FleetError.MachineOffline -> R.string.fleet_error_offline
    FleetError.EmptyResponse -> R.string.fleet_error_empty_response
    FleetError.InvalidInput -> R.string.fleet_error_invalid_input
    FleetError.Timeout -> R.string.fleet_error_timeout
    FleetError.Network -> R.string.fleet_error_network
    FleetError.Unknown, is FleetError.Localized -> R.string.fleet_error_unknown
    is FleetError.Http -> when (status) {
        401 -> R.string.fleet_error_http_401
        403 -> R.string.fleet_error_http_403
        404 -> R.string.fleet_error_http_404
        409 -> R.string.fleet_error_http_409
        408 -> R.string.fleet_error_timeout
        429 -> R.string.fleet_error_http_429
        in 500..599 -> R.string.fleet_error_http_server
        else -> R.string.fleet_error_http_other
    }
    is FleetError.Download -> when (reason) {
        DownloadError.INVALID_LOCAL_SIZE -> R.string.fleet_error_download_local_size
        DownloadError.INVALID_LENGTH -> R.string.fleet_error_download_length
        DownloadError.INVALID_RANGE -> R.string.fleet_error_download_range
        DownloadError.RANGE_MISMATCH -> R.string.fleet_error_download_range_mismatch
        DownloadError.VALIDATOR_CHANGED -> R.string.fleet_error_download_validator
        DownloadError.LENGTH_MISMATCH -> R.string.fleet_error_download_length_mismatch
        DownloadError.TOO_LARGE -> R.string.fleet_error_download_too_large
        DownloadError.INVALID_RESPONSE -> R.string.fleet_error_download_response
        DownloadError.STORAGE_PERMISSION -> R.string.fleet_error_download_storage_permission
        DownloadError.MACHINE_MISSING -> R.string.fleet_error_download_machine_missing
        DownloadError.STORAGE -> R.string.fleet_error_download_storage
        DownloadError.INTERRUPTED -> R.string.fleet_error_download_interrupted
    }
}

/** Small pure formatter also lets JVM tests check UI copy without a device Context. */
internal fun FleetError.renderText(string: (Int, Array<out Any>) -> String): String {
    if (this is FleetError.Localized) return message
    val resource = stringResource()
    var text = string(resource, if (this is FleetError.Http && resource == R.string.fleet_error_http_other) arrayOf(status) else emptyArray())
    if (this is FleetError.Http) {
        retryAfterSeconds?.let { text = string(R.string.fleet_error_retry_after, arrayOf<Any>(text, it)) }
        serverMessage?.takeIf { it.isNotBlank() }?.let { text = string(R.string.fleet_error_server_detail, arrayOf(text, it)) }
    }
    return text
}

fun Context.errorText(error: FleetError): String = error.renderText { resource, arguments -> getString(resource, *arguments) }
