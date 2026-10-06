package dev.primeagent.fleet

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl

/** All byte counts are Long: the allowed size includes exactly 2 GiB. No Android dependencies. */
object RangeResume {
    const val MAX_BYTES = 2L * 1024 * 1024 * 1024

    sealed interface Decision {
        data class Receive(val append: Boolean, val total: Long?, val bodyBytes: Long?) : Decision
        data object Restart : Decision
        data class Reject(val reason: String) : Decision
    }

    fun strongETag(value: String?): Boolean = value != null &&
        value.length >= 2 && value.first() == '"' && value.last() == '"' &&
        value.substring(1, value.lastIndex).all { it.code in 0x21..0xff && it != '"' && it.code != 0x7f }

    fun decide(
        status: Int,
        offset: Long,
        contentRange: String?,
        contentLength: Long?,
        savedETag: String?,
        responseETag: String?,
        savedTotal: Long? = null,
    ): Decision {
        if (offset !in 0..MAX_BYTES) return Decision.Reject("Invalid local size")
        if (contentLength != null && contentLength !in 0..MAX_BYTES) {
            return Decision.Reject("File exceeds 2 GiB or has an invalid length")
        }
        if (status == 200) return Decision.Receive(false, contentLength, contentLength)
        if (status == 416 && offset > 0) return Decision.Restart
        if (status != 206) return Decision.Reject("Unexpected HTTP status $status")
        val match = Regex("bytes ([0-9]+)-([0-9]+)/([0-9]+)").matchEntire(contentRange.orEmpty())
            ?: return Decision.Reject("Invalid Content-Range")
        val (start, end, total) = match.groupValues.drop(1).map { it.toLongOrNull() }
        if (start == null || end == null || total == null || total !in 1..MAX_BYTES ||
            start != offset || end < start || end >= total || end != total - 1) {
            return Decision.Reject("Content-Range does not match the requested tail")
        }
        if (offset > 0 && (!strongETag(savedETag) || savedETag != responseETag ||
                (savedTotal != null && savedTotal != total))) {
            return Decision.Reject("The partial file validator changed")
        }
        val bytes = end - start + 1
        if (contentLength != null && contentLength != bytes) {
            return Decision.Reject("Content-Length disagrees with Content-Range")
        }
        return Decision.Receive(offset > 0, total, bytes)
    }
}

object Downloads {
    fun enqueue(context: Context, machineId: String, cwd: String, path: String): UUID {
        require(machineId.isNotBlank() && cwd.isNotBlank() && path.isNotBlank())
        val request = OneTimeWorkRequestBuilder<FleetDownloadWorker>()
            .setInputData(workDataOf("machineId" to machineId, "cwd" to cwd, "path" to path))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag("fleet-download")
            .build()
        WorkManager.getInstance(context.applicationContext).enqueue(request)
        return request.id
    }

    fun open(context: Context, uri: Uri, mimeType: String = "application/octet-stream") {
        context.startActivity(openIntent(uri, mimeType))
    }

    fun open(context: Context, uri: String, mimeType: String = "application/octet-stream") =
        open(context, Uri.parse(uri), mimeType)

    internal fun openIntent(uri: Uri, mimeType: String): Intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, mimeType)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        .apply { clipData = ClipData.newRawUri(uri.lastPathSegment ?: "file", uri) }
}

@Serializable
private data class DownloadMetadata(
    val etag: String? = null,
    val total: Long? = null,
    val mimeType: String = "application/octet-stream",
    val complete: Boolean = false,
)

/** WorkManager retries reuse this work UUID, including after process death. Tokens stay out of work data. */
class FleetDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    private val directory = File(applicationContext.filesDir, "downloads/$id")
    private val partial = File(directory, "partial")
    private val metadataFile = File(directory, "metadata.json")
    private val notificationId = (id.hashCode() and Int.MAX_VALUE).coerceAtLeast(1)
    private val notifications = applicationContext.getSystemService(NotificationManager::class.java)
    private var displayName = text(R.string.dl_download)
    private var lastProgress = 0L

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            val machineId = inputData.getString("machineId") ?: throw InvalidDownload(text(R.string.dl_invalid_request))
            val cwd = inputData.getString("cwd") ?: throw InvalidDownload(text(R.string.dl_invalid_request))
            val path = inputData.getString("path") ?: throw InvalidDownload(text(R.string.dl_invalid_request))
            displayName = path.replace('\\', '/').substringAfterLast('/').replace(Regex("[\\p{Cntrl}]"), "_")
                .take(180).takeUnless { it.isBlank() || it == "." || it == ".." } ?: text(R.string.dl_download)
            while (displayName.toByteArray(Charsets.UTF_8).size > 180) displayName = displayName.dropLast(1)
            setForeground(foreground(0, null))
            if (Build.VERSION.SDK_INT < 29 && applicationContext.checkSelfPermission(
                    Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                throw InvalidDownload(text(R.string.dl_storage_permission))
            }
            val machine = FleetStore(applicationContext).machines().firstOrNull { it.id == machineId }
                ?: throw InvalidDownload(text(R.string.dl_machine_missing))
            val url = validatedBaseUrl(machine.baseUrl).toHttpUrl().newBuilder()
                .addPathSegments("api/project-files/download")
                .addQueryParameter("cwd", cwd).addQueryParameter("path", path).build()
            if (!directory.exists() && !directory.mkdirs()) throw IOException(text(R.string.dl_storage_error))
            val cached = readMetadata()
            val metadata = if (cached?.complete == true && cached.total != null &&
                cached.total in 0..RangeResume.MAX_BYTES && cached.total == partial.length() && partial.exists()) {
                cached
            } else {
                transfer(url.toString(), machine.token, cached)
            }
            currentCoroutineContext().ensureActive()
            val uri = publish(metadata.mimeType)
            directory.deleteRecursively()
            val notification = notification(metadata.total ?: 0, metadata.total, uri, metadata.mimeType)
            // Android 13 notification permission is optional for a foreground transfer.
            try { notifications.notify(notificationId xor Int.MIN_VALUE, notification) } catch (_: SecurityException) { }
            Result.success(workDataOf("uri" to uri.toString(), "mimeType" to metadata.mimeType, "name" to displayName))
        } catch (e: CancellationException) {
            throw e // Preserve the partial for WorkManager interruption, never swallow cancellation.
        } catch (e: IOException) {
            if (runAttemptCount < 8) Result.retry() else failure(text(R.string.dl_io_failed))
        } catch (e: InvalidDownload) {
            failure(e.message ?: text(R.string.dl_failed))
        } catch (_: Exception) {
            failure(text(R.string.dl_failed))
        }
    }

    private fun text(resource: Int): String = applicationContext.getString(resource)

    private fun failure(message: String): Result {
        directory.deleteRecursively()
        return Result.failure(workDataOf("error" to message.take(500)))
    }

    private fun readMetadata(): DownloadMetadata? = try {
        Json.decodeFromString<DownloadMetadata>(metadataFile.readText())
    } catch (_: Exception) { null }

    private fun saveMetadata(metadata: DownloadMetadata) {
        val temporary = File(directory, "metadata.tmp")
        FileOutputStream(temporary).use { stream ->
            stream.write(Json.encodeToString(metadata).toByteArray(Charsets.UTF_8))
            stream.fd.sync()
        }
        if (!temporary.renameTo(metadataFile)) throw IOException(text(R.string.dl_storage_error))
    }

    private suspend fun transfer(url: String, token: String, cached: DownloadMetadata?): DownloadMetadata {
        var metadata = cached
        var offset = partial.takeIf { it.exists() }?.length() ?: 0L
        if (offset > RangeResume.MAX_BYTES) throw InvalidDownload(text(R.string.dl_too_large))
        if (offset > 0 && (!RangeResume.strongETag(metadata?.etag) ||
                (metadata?.total?.let { offset > it } == true))) {
            FileOutputStream(partial).close()
            offset = 0
            metadata = null
        }
        // A 416 can indicate a changed file or a full partial without a completion marker.
        // One unconditional request repairs that state; a second 416 is an error.
        repeat(2) {
            val request = Request.Builder().url(url)
                .header("Authorization", "Bearer $token")
                .header("Accept-Encoding", "identity")
                .apply {
                    if (offset > 0) {
                        header("Range", "bytes=$offset-")
                        header("If-Range", metadata!!.etag!!)
                    }
                }.build()
            val call = client.newCall(request)
            val downloaded = coroutineScope {
                // Closing the socket also interrupts a blocking body read on cancellation.
                val cancellation = launch(start = CoroutineStart.UNDISPATCHED) {
                    try { awaitCancellation() } finally { call.cancel() }
                }
                try {
                    call.execute().use { response ->
                        if (response.code == 408 || response.code == 429 || response.code >= 500) {
                            throw IOException(text(R.string.dl_server_retry))
                        }
                        val body = response.body ?: throw InvalidDownload(text(R.string.dl_response_invalid))
                        val encoding = response.header("Content-Encoding")
                        if (encoding != null && !encoding.equals("identity", ignoreCase = true)) {
                            throw InvalidDownload(text(R.string.dl_response_invalid))
                        }
                        val decision = RangeResume.decide(
                            response.code, offset, response.header("Content-Range"),
                            body.contentLength().takeIf { it >= 0 }, metadata?.etag,
                            response.header("ETag"), metadata?.total,
                        )
                        when (decision) {
                            RangeResume.Decision.Restart -> null
                            is RangeResume.Decision.Reject -> throw InvalidDownload(text(R.string.dl_response_invalid))
                            is RangeResume.Decision.Receive -> {
                                if (!decision.append) {
                                    FileOutputStream(partial).close()
                                    offset = 0
                                }
                                val mime = response.header("Content-Type")?.substringBefore(';')?.trim()
                                    ?.takeIf { it.isNotEmpty() }
                                    ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                                        displayName.substringAfterLast('.', "").lowercase())
                                    ?: "application/octet-stream"
                                val next = DownloadMetadata(response.header("ETag"), decision.total, mime)
                                saveMetadata(next)
                                var received = 0L
                                val buffer = ByteArray(64 * 1024)
                                FileOutputStream(partial, decision.append).use { output ->
                                    body.byteStream().use { input ->
                                        while (true) {
                                            currentCoroutineContext().ensureActive()
                                            val count = input.read(buffer)
                                            if (count < 0) break
                                            if (offset + received + count > RangeResume.MAX_BYTES ||
                                                (decision.bodyBytes != null && received + count > decision.bodyBytes)) {
                                                throw InvalidDownload(text(R.string.dl_too_large))
                                            }
                                            output.write(buffer, 0, count)
                                            received += count
                                            updateProgress(offset + received, decision.total)
                                        }
                                    }
                                    output.fd.sync()
                                }
                                if (decision.bodyBytes != null && received != decision.bodyBytes) {
                                    throw IOException(text(R.string.dl_interrupted))
                                }
                                currentCoroutineContext().ensureActive()
                                next.copy(total = offset + received, complete = true).also { saveMetadata(it) }
                            }
                        }
                    }
                } finally { cancellation.cancel() }
            }
            if (downloaded != null) return downloaded
            FileOutputStream(partial).close()
            metadataFile.delete()
            metadata = null
            offset = 0
        }
        throw InvalidDownload(text(R.string.dl_response_invalid))
    }

    private suspend fun updateProgress(bytes: Long, total: Long?) {
        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastProgress < 500) return
        lastProgress = now
        setProgress(workDataOf("bytes" to bytes, "total" to (total ?: -1L)))
        try { notifications.notify(notificationId, notification(bytes, total)) } catch (_: SecurityException) { }
    }

    private fun foreground(bytes: Long, total: Long?): ForegroundInfo {
        val notification = notification(bytes, total)
        return if (Build.VERSION.SDK_INT >= 29) {
            ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else ForegroundInfo(notificationId, notification)
    }

    private fun notification(bytes: Long, total: Long?, uri: Uri? = null, mime: String = "application/octet-stream"): Notification {
        notifications.createNotificationChannel(NotificationChannel(CHANNEL, text(R.string.dl_channel), NotificationManager.IMPORTANCE_LOW))
        val builder = Notification.Builder(applicationContext, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(displayName)
            .setContentText(if (uri == null) text(R.string.dl_downloading) else text(R.string.dl_saved))
            .setOnlyAlertOnce(true).setOngoing(uri == null)
        if (uri == null) {
            val percent = if (total != null && total > 0) ((bytes.toDouble() / total) * 100).toInt().coerceIn(0, 100) else 0
            builder.setProgress(100, percent, total == null)
            builder.addAction(Notification.Action.Builder(null, text(R.string.dl_cancel),
                WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)).build())
        } else {
            builder.setAutoCancel(true).setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(PendingIntent.getActivity(applicationContext, notificationId,
                    Downloads.openIntent(uri, mime), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        return builder.build()
    }

    private suspend fun publish(mime: String): Uri {
        val resolver = applicationContext.contentResolver
        if (Build.VERSION.SDK_INT >= 29) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(MediaStore.Downloads.MIME_TYPE, mime)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException(text(R.string.dl_storage_error))
            try {
                val output = resolver.openOutputStream(uri, "w") ?: throw IOException(text(R.string.dl_storage_error))
                output.use { copyPartial(it) }
                currentCoroutineContext().ensureActive()
                if (resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null) != 1) {
                    throw IOException(text(R.string.dl_storage_error))
                }
                return uri
            } catch (e: Exception) {
                try { resolver.delete(uri, null, null) } catch (_: Exception) { }
                throw e
            }
        }
        @Suppress("DEPRECATION")
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!downloads.exists() && !downloads.mkdirs()) throw IOException(text(R.string.dl_storage_error))
        val stem = displayName.substringBeforeLast('.', displayName)
        val extension = displayName.substringAfterLast('.', "").takeIf { displayName.contains('.') }
        var destination = File(downloads, displayName)
        var suffix = 0
        while (!destination.createNewFile()) {
            suffix++
            destination = File(downloads, "$stem ($suffix)" + (extension?.let { ".$it" } ?: ""))
        }
        try {
            FileOutputStream(destination).use { output -> copyPartial(output); output.fd.sync() }
            currentCoroutineContext().ensureActive()
            return FileProvider.getUriForFile(applicationContext, "${applicationContext.packageName}.files", destination)
        } catch (e: Exception) {
            destination.delete()
            throw e
        }
    }

    private suspend fun copyPartial(output: java.io.OutputStream) {
        val buffer = ByteArray(64 * 1024)
        partial.inputStream().use { input ->
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer)
                if (count < 0) break
                output.write(buffer, 0, count)
            }
        }
        output.flush()
    }

    private class InvalidDownload(message: String) : Exception(message)

    companion object {
        private const val CHANNEL = "fleet-downloads"
        private val client = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build()
    }
}
