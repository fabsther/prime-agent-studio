package dev.primeagent.fleet

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject

/** Tokens never enter the summary cache, backups, logs or WorkManager input. */
class FleetStore(context: Context) {
    private val preferences = EncryptedSharedPreferences.create(context, "fleet-secrets", MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(), EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    private val cache = File(context.filesDir, "fleet-cache").apply { mkdirs() }
    fun machines(): List<Machine> = fleetJson.decodeFromString(preferences.getString("machines", "[]")!!)
    fun saveMachines(machines: List<Machine>) { check(preferences.edit().putString("machines", fleetJson.encodeToString(machines)).commit()) }
    fun owner(key: String): String? = preferences.getString("owner:$key", null)
    fun setOwner(key: String, id: String) { preferences.edit().putString("owner:$key", id).apply() }
    private fun cacheFile(key: String) = File(cache, java.security.MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) } + ".json")
    @Synchronized fun save(key: String, text: String) { val file = cacheFile(key); val temp = File(file.path + ".tmp"); temp.writeText(text); check(temp.renameTo(file)) }
    @Synchronized fun read(key: String): String? = cacheFile(key).takeIf { it.exists() }?.readText()
    fun summary(id: String): FleetSummary? = runCatching { read("summary:$id")?.let { fleetJson.decodeFromString<FleetSummary>(it) } }.getOrNull()
    fun remove(id: String) { saveMachines(machines().filterNot { it.id == id }); cacheFile("summary:$id").delete() }
}
