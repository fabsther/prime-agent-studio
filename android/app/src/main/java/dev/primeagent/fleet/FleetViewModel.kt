package dev.primeagent.fleet

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

class DelegationLinkException(message: String, cause: Throwable) : IllegalStateException(message, cause)

class FleetViewModel(application: Application) : AndroidViewModel(application) {
    private val store = FleetStore(application)
    private val api = FleetApi()
    private val _state = MutableStateFlow(FleetState(machines = store.machines(), snapshots = store.machines().map { Snapshot(it, store.summary(it.id), false) }))
    val state: StateFlow<FleetState> = _state.asStateFlow()
    private var polling: Job? = null
    private val refreshLock = Mutex()
    private var demoMode = false
    fun startPolling() { if (polling?.isActive != true) polling = viewModelScope.launch { while (isActive) { refreshNow(); delay(8000) } } }
    fun stopPolling() { polling?.cancel(); polling = null }
    fun refresh() { viewModelScope.launch { refreshNow() } }
    private suspend fun refreshNow() = refreshLock.withLock {
        if (demoMode) return@withLock
        val machines = _state.value.machines
        val snapshots = coroutineScope { machines.map { machine -> async {
            try {
                val identity = fleetJson.decodeFromJsonElement<Identity>(api.json(machine, "/api/fleet/identity"))
                check(identity.apiVersion == 1 && identity.machineId == machine.id) { "Incompatible machine identity" }
                val summary = fleetJson.decodeFromJsonElement<FleetSummary>(api.json(machine, "/api/fleet/summary"))
                check(summary.machine.machineId == machine.id)
                withContext(Dispatchers.IO) { store.save("summary:${machine.id}", fleetJson.encodeToString(summary)) }
                Snapshot(machine, summary, true)
            } catch (e: CancellationException) { throw e } catch (e: Exception) { Snapshot(machine, _state.value.snapshots.firstOrNull { it.machine.id == machine.id }?.summary, false) }
        } }.awaitAll() }
        // A remove/rename during the request must not resurrect the old machine.
        _state.update { old -> old.copy(snapshots = snapshots.filter { row -> old.machines.any { it.id == row.machine.id } }.map { row -> row.copy(machine = old.machines.first { it.id == row.machine.id }) }) }
    }
    private fun action(block: suspend () -> Unit) { viewModelScope.launch {
        _state.update { it.copy(busy = true, error = null) }
        try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { _state.update { it.copy(error = e.message ?: "Error") } }
        finally { _state.update { it.copy(busy = false) } }
    } }
    fun pair(url: String, pin: String, name: String) = action {
        require(pin.isNotBlank() && name.isNotBlank())
        val machine = api.pair(url, pin, name)
        demoMode = false
        val machines = store.machines().filterNot { it.id == machine.id } + machine
        withContext(Dispatchers.IO) { store.saveMachines(machines) }
        _state.update { it.copy(machines = machines, snapshots = it.snapshots.filterNot { row -> row.machine.id.startsWith("demo-") }) }
        refreshNow()
    }
    fun rename(id: String, name: String) { if (name.isBlank()) return; val machines = _state.value.machines.map { if (it.id == id) it.copy(name = name.trim()) else it }; if (!demoMode) store.saveMachines(machines); _state.update { it.copy(machines = machines, snapshots = it.snapshots.map { row -> row.copy(machine = machines.first { machine -> machine.id == row.machine.id }) }) } }
    fun remove(id: String) { if (!demoMode) store.remove(id); _state.update { it.copy(machines = it.machines.filterNot { m -> m.id == id }, snapshots = it.snapshots.filterNot { row -> row.machine.id == id }) } }
    fun owner(key: String): String? = store.owner(key)
    fun setOwner(key: String, id: String) = store.setOwner(key, id)
    suspend fun history(machine: Machine, id: String): JsonObject = if (demoMode) Demo.history else api.json(machine, "/api/history", mapOf("id" to id)).jsonObject
    fun events(machine: Machine, runId: String): Flow<JsonObject> = if (demoMode) emptyFlow() else api.events(machine, runId)
    suspend fun send(machine: Machine, project: Project, session: Session, message: String) {
        require(message.isNotBlank())
        if (demoMode) return
        if (session.runId != null && session.status in listOf("running", "waiting")) {
            api.json(machine, "/api/live/sessions/${java.net.URLEncoder.encode(session.id, "UTF-8")}/messages", body = buildJsonObject { put("cwd", project.cwd); put("message", message); put("mode", "followUp"); put("requestId", java.util.UUID.randomUUID().toString()) })
        } else {
            api.json(machine, "/api/runs", body = buildJsonObject { put("cwd", project.cwd); put("message", message); if (session.id.isNotBlank()) put("sessionId", session.id); put("allowQuestions", true) })
        }
        refreshNow()
    }
    suspend fun stop(machine: Machine, runId: String) { if (!demoMode) { api.json(machine, "/api/runs/${java.net.URLEncoder.encode(runId, "UTF-8")}/stop", body = buildJsonObject {}); refreshNow() } }
    suspend fun outputs(machine: Machine, cwd: String): List<OutputFile> = if (demoMode) emptyList() else fleetJson.decodeFromJsonElement(api.json(machine, "/api/project-files/recent-outputs", mapOf("cwd" to cwd)))
    suspend fun roadmap(machine: Machine, cwd: String): JsonObject {
        if (demoMode) return Demo.roadmap
        val key = "roadmap:${machine.id}:$cwd"
        return try { api.json(machine, "/api/roadmap", mapOf("cwd" to cwd)).jsonObject.also { withContext(Dispatchers.IO) { store.save(key, it.toString()) } } } catch (e: CancellationException) { throw e } catch (e: Exception) { withContext(Dispatchers.IO) { store.read(key)?.let { fleetJson.parseToJsonElement(it).jsonObject } ?: throw e } }
    }
    suspend fun delegate(owner: ProjectRow, target: ProjectRow, planId: String, stepId: String, stepText: String, prompt: String, expectedRevision: Long?) {
        check(owner.snapshot.online && target.snapshot.online) { "Machine offline" }
        if (demoMode) return
        val result = api.json(target.snapshot.machine, "/api/fleet/delegate", body = buildJsonObject { put("cwd", target.project.cwd); target.project.git?.originKey?.let { put("originKey", it) }; put("prompt", prompt.ifBlank { stepText }); put("planId", planId); put("stepId", stepId); put("stepText", stepText); put("ownerMachineId", owner.snapshot.machine.id) }).jsonObject
        val sessionId = result.getValue("sessionId").jsonPrimitive.content
        try {
            api.json(owner.snapshot.machine, "/api/roadmap/external-link", body = buildJsonObject { put("cwd", owner.project.cwd); put("planId", planId); put("stepId", stepId); put("machineId", target.snapshot.machine.id); put("machineName", target.snapshot.machine.name); put("sessionId", sessionId); expectedRevision?.let { put("expectedRevision", it) } })
        } catch (e: Exception) { throw DelegationLinkException(getApplication<Application>().getString(R.string.delegation_link_failed, target.snapshot.machine.name, sessionId, e.message.orEmpty()), e) }
        refreshNow()
    }
    fun demo() { demoMode = true; _state.value = Demo.state }
}
