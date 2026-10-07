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
    private val refreshLocks = mutableMapOf<String, Mutex>()
    private var demoMode = false
    private var detailVisible = false
    private val statusVersions = mutableMapOf<Pair<String, String>, Long>()
    private val statusBarriers = mutableMapOf<Pair<String, String>, Long>()
    private val pendingRuns = mutableMapOf<Pair<String, String>, String>()
    fun setDetailVisible(visible: Boolean) {
        if (detailVisible == visible) return
        detailVisible = visible
        if (polling?.isActive == true) { stopPolling(); startPolling() }
    }
    fun startPolling() {
        if (polling?.isActive == true) return
        polling = viewModelScope.launch {
            state.map { it.machines }.distinctUntilChanged().collectLatest { machines ->
                coroutineScope {
                    machines.forEach { machine -> launch {
                        // An offline machine cannot stall a visible conversation on another machine.
                        while (isActive) { refreshMachine(machine); delay(if (detailVisible) 4000 else 8000) }
                    } }
                }
            }
        }
    }
    fun stopPolling() { polling?.cancel(); polling = null }
    fun refresh() { viewModelScope.launch { refreshNow() } }
    private suspend fun refreshNow() = coroutineScope {
        _state.value.machines.map { machine -> async { refreshMachine(machine) } }.awaitAll()
        Unit
    }
    private suspend fun refreshMachine(machine: Machine) = refreshLocks.getOrPut(machine.id) { Mutex() }.withLock {
        if (demoMode) return@withLock
        val versions = statusVersions.toMap()
        val snapshot = try {
            val identity = fleetJson.decodeFromJsonElement<Identity>(api.json(machine, "/api/fleet/identity"))
            if (identity.apiVersion != 1 || identity.machineId != machine.id) throw FleetException(FleetError.IncompatibleIdentity)
            val summary = fleetJson.decodeFromJsonElement<FleetSummary>(api.json(machine, "/api/fleet/summary"))
            if (summary.machine.machineId != machine.id) throw FleetException(FleetError.IncompatibleIdentity)
            withContext(Dispatchers.IO) { store.save("summary:${machine.id}", fleetJson.encodeToString(summary)) }
            Snapshot(machine, summary, true)
        } catch (e: CancellationException) { throw e } catch (e: Exception) {
            Snapshot(machine, _state.value.snapshots.firstOrNull { it.machine.id == machine.id }?.summary, false, e.toFleetError())
        }
        _state.update { old ->
            // A remove/rename during the request must not resurrect the old machine.
            val currentMachine = old.machines.firstOrNull { it.id == machine.id } ?: return@update old
            val summary = snapshot.summary?.let { summary -> summary.copy(projects = summary.projects.map { project ->
                // A slow request must not overwrite a newer send/SSE status with stale state.
                val sessions = project.sessions.map { session ->
                    val key = machine.id to session.id
                    val pending = pendingRuns[key]
                    if (pending != null && session.runId == pending) pendingRuns.remove(key)
                    val changedDuringRequest = statusVersions[key] != versions[key]
                    if (changedDuringRequest) statusBarriers[key] = maxOf(statusBarriers[key] ?: 0, summary.generatedAt)
                    val stale = summarySessionIsStale(session, summary.generatedAt, statusBarriers[key], pending)
                    if (!stale && !changedDuringRequest) statusBarriers.remove(key)
                    if (changedDuringRequest || stale) old.linkedSession(key.first, key.second) ?: session else session
                }
                project.withSessionStatuses(sessions)
            }) }
            old.copy(snapshots = old.snapshots.filterNot { it.machine.id == machine.id } + snapshot.copy(machine = currentMachine, summary = summary))
        }
    }
    private fun action(block: suspend () -> Unit) { viewModelScope.launch {
        _state.update { it.copy(busy = true, error = null) }
        try { block() } catch (e: CancellationException) { throw e } catch (e: Exception) { _state.update { it.copy(error = e.toFleetError()) } }
        finally { _state.update { it.copy(busy = false) } }
    } }
    fun pair(url: String, pin: String, name: String) = action {
        if (pin.isBlank() || name.isBlank()) throw FleetException(FleetError.InvalidInput)
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
    private fun updateStatus(machineId: String, sessionId: String, change: (Session) -> Session) {
        val key = machineId to sessionId
        statusVersions[key] = (statusVersions[key] ?: 0L) + 1
        _state.value.snapshots.firstOrNull { it.machine.id == machineId }?.summary?.generatedAt?.let { statusBarriers[key] = it }
        _state.update { it.updateSession(machineId, sessionId, change) }
    }
    fun events(machine: Machine, sessionId: String, runId: String): Flow<JsonObject> = if (demoMode) emptyFlow() else api.events(machine, runId).onEach { event ->
        val session = _state.value.linkedSession(machine.id, sessionId)
        if (session?.runId == runId) {
            val status = reduceSessionStatus(session.status, event)
            if ((event["kind"] as? JsonPrimitive)?.contentOrNull == "done") pendingRuns.remove(machine.id to sessionId)
            if (status != session.status) updateStatus(machine.id, sessionId) { it.copy(status = status) }
        }
    }
    suspend fun send(machine: Machine, project: Project, session: Session, message: String) {
        if (message.isBlank()) throw FleetException(FleetError.InvalidInput)
        if (demoMode) return
        val followUp = session.runId != null && session.status in listOf("running", "waiting")
        updateStatus(machine.id, session.id) { it.copy(status = "running", runId = if (followUp) it.runId else null) }
        try {
            if (followUp) {
                api.json(machine, "/api/live/sessions/${java.net.URLEncoder.encode(session.id, "UTF-8")}/messages", body = buildJsonObject { put("cwd", project.cwd); put("message", message); put("mode", "followUp"); put("requestId", java.util.UUID.randomUUID().toString()) })
            } else {
                val result = api.json(machine, "/api/runs", body = buildJsonObject { put("cwd", project.cwd); put("message", message); if (session.id.isNotBlank()) put("sessionId", session.id); put("allowQuestions", true) }).jsonObject
                val runId = (result["id"] as? JsonPrimitive)?.contentOrNull
                if (runId != null && session.id.isNotBlank()) pendingRuns[machine.id to session.id] = runId
                updateStatus(machine.id, session.id) { it.copy(status = "running", runId = runId ?: it.runId) }
            }
        } catch (e: Exception) {
            pendingRuns.remove(machine.id to session.id)
            updateStatus(machine.id, session.id) { it.copy(status = session.status, runId = session.runId) }
            throw e
        }
        refreshMachine(machine)
    }
    suspend fun stop(machine: Machine, runId: String) { if (!demoMode) { api.json(machine, "/api/runs/${java.net.URLEncoder.encode(runId, "UTF-8")}/stop", body = buildJsonObject {}); refreshMachine(machine) } }
    suspend fun outputs(machine: Machine, cwd: String): List<OutputFile> = if (demoMode) emptyList() else fleetJson.decodeFromJsonElement(api.json(machine, "/api/project-files/recent-outputs", mapOf("cwd" to cwd)))
    suspend fun roadmap(machine: Machine, cwd: String): JsonObject {
        if (demoMode) return Demo.roadmap
        val key = "roadmap:${machine.id}:$cwd"
        return try { api.json(machine, "/api/roadmap", mapOf("cwd" to cwd)).jsonObject.also { withContext(Dispatchers.IO) { store.save(key, it.toString()) } } } catch (e: CancellationException) { throw e } catch (e: Exception) { withContext(Dispatchers.IO) { store.read(key)?.let { fleetJson.parseToJsonElement(it).jsonObject } ?: throw e } }
    }
    suspend fun delegate(owner: ProjectRow, target: ProjectRow, planId: String, stepId: String, stepText: String, prompt: String, expectedRevision: Long?) {
        if (!owner.snapshot.online || !target.snapshot.online) throw FleetException(FleetError.MachineOffline)
        if (demoMode) return
        val result = api.json(target.snapshot.machine, "/api/fleet/delegate", body = buildJsonObject { put("cwd", target.project.cwd); target.project.git?.originKey?.let { put("originKey", it) }; put("prompt", prompt.ifBlank { stepText }); put("planId", planId); put("stepId", stepId); put("stepText", stepText); put("ownerMachineId", owner.snapshot.machine.id) }).jsonObject
        val sessionId = result.getValue("sessionId").jsonPrimitive.content
        try {
            api.json(owner.snapshot.machine, "/api/roadmap/external-link", body = buildJsonObject { put("cwd", owner.project.cwd); put("planId", planId); put("stepId", stepId); put("machineId", target.snapshot.machine.id); put("machineName", target.snapshot.machine.name); put("sessionId", sessionId); expectedRevision?.let { put("expectedRevision", it) } })
        } catch (e: Exception) { throw DelegationLinkException(getApplication<Application>().getString(R.string.delegation_link_failed, target.snapshot.machine.name, sessionId, getApplication<Application>().errorText(e.toFleetError())), e) }
        refreshNow()
    }
    fun demo() { demoMode = true; _state.value = Demo.state }
}
