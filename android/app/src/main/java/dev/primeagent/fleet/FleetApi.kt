package dev.primeagent.fleet

import java.io.IOException
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

// Tailscale Serve only exposes HTTPS on these ports (one Studio per port).
val TAILSCALE_SERVE_HTTPS_PORTS = setOf(443, 8443, 10000)

fun validatedBaseUrl(raw: String): String {
    val url = try { raw.trim().toHttpUrl() } catch (e: IllegalArgumentException) { throw FleetException(FleetError.InvalidTailscaleUrl, e) }
    if (!(url.isHttps && url.host.endsWith(".ts.net") && url.host.removeSuffix(".ts.net").contains('.') && url.username.isEmpty() && url.password.isEmpty() && url.encodedPath == "/" && url.query == null && url.fragment == null && url.port in TAILSCALE_SERVE_HTTPS_PORTS)) throw FleetException(FleetError.InvalidTailscaleUrl)
    return url.toString().trimEnd('/')
}

class FleetApi {
    private val client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
    private val streaming = client.newBuilder().readTimeout(0, TimeUnit.SECONDS).build()
    private fun request(machine: Machine, path: String, query: Map<String, String> = emptyMap()): Request.Builder {
        val url = (validatedBaseUrl(machine.baseUrl) + path).toHttpUrl().newBuilder()
        query.forEach { (key, value) -> url.addQueryParameter(key, value) }
        return Request.Builder().url(url.build()).header("Authorization", "Bearer ${machine.token}")
    }
    suspend fun json(machine: Machine, path: String, query: Map<String, String> = emptyMap(), body: JsonObject? = null): JsonElement = withContext(Dispatchers.IO) {
        val builder = request(machine, path, query)
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            if (!response.isSuccessful) throw httpError(response)
            val text = response.body?.string()?.takeIf { it.isNotBlank() } ?: throw FleetException(FleetError.EmptyResponse)
            fleetJson.parseToJsonElement(text)
        }
    }
    suspend fun pair(url: String, pin: String, name: String): Machine {
        val base = validatedBaseUrl(url)
        val response = json(Machine("", "", base, ""), "/api/fleet/pair", body = buildJsonObject { put("pin", pin); put("deviceName", name) }).jsonObject
        return Machine(response.getValue("machineId").jsonPrimitive.content, response.getValue("machineName").jsonPrimitive.content, base, response.getValue("token").jsonPrimitive.content)
    }
    fun events(machine: Machine, runId: String): Flow<JsonObject> = callbackFlow {
        var after = 0L
        var done = false
        var currentCall: Call? = null
        val reader = launch(Dispatchers.IO) {
            while (!done) {
                try {
                    val call = streaming.newCall(request(machine, "/api/runs/${java.net.URLEncoder.encode(runId, "UTF-8")}/events", mapOf("after" to after.toString())).build())
                    currentCall = call
                    call.execute().use { response ->
                        if (!response.isSuccessful) throw httpError(response)
                        val source = (response.body ?: throw FleetException(FleetError.EmptyResponse)).source()
                        val data = StringBuilder()
                        while (!done && !source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            if (line.isEmpty() && data.isNotEmpty()) {
                                val event = fleetJson.parseToJsonElement(data.toString().trimEnd()).jsonObject
                                data.setLength(0)
                                val seq = event["seq"]?.jsonPrimitive?.longOrNull
                                if (seq == null || seq > after) {
                                    after = seq ?: after
                                    send(event)
                                    done = event["kind"]?.jsonPrimitive?.content == "done"
                                }
                            } else if (line.startsWith("data:")) data.append(line.removePrefix("data:").trimStart()).append('\n')
                        }
                    }
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    val problem = error.toFleetError()
                    if (problem is FleetError.Http && !problem.retryable) {
                        close(FleetException(problem)); return@launch
                    }
                    // Transient SSE loss is reconnectable; summary polling reports connectivity.
                    val retry = (problem as? FleetError.Http)?.retryAfterSeconds
                    if (retry != null) kotlinx.coroutines.delay(retry.coerceAtMost(60) * 1000)
                }
                if (!done) kotlinx.coroutines.delay(2000)
            }
            close()
        }
        awaitClose { currentCall?.cancel(); reader.cancel() }
    }
}
