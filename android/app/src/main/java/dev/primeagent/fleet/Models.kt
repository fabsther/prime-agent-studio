package dev.primeagent.fleet

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val fleetJson = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

@Serializable data class Machine(val id: String, val name: String, val baseUrl: String, val token: String)
@Serializable data class Identity(val apiVersion: Int = 1, val machineId: String, val machineName: String, val studioVersion: String = "", val capabilities: List<String> = emptyList())
@Serializable data class FleetSummary(val machine: Identity, val generatedAt: Long, val projects: List<Project> = emptyList())
@Serializable data class Git(val origin: String? = null, val originKey: String? = null, val branch: String? = null, val dirty: Boolean = false, val changedFiles: Int = 0)
@Serializable data class Project(val cwd: String, val name: String, val git: Git? = null, val activeRuns: Int = 0, val lastActivityAt: Long? = null, val sessions: List<Session> = emptyList())
@Serializable data class RoadmapLink(val planId: String, val stepId: String, val ownerMachineId: String)
@Serializable data class Session(val id: String, val title: String = "", val status: String = "idle", val updatedAt: Long = 0, val runId: String? = null, val roadmapLink: RoadmapLink? = null, val agents: List<Agent> = emptyList())
@Serializable data class Agent(val id: String, val parentId: String? = null, val name: String = "", val status: String = "idle", val model: String? = null, val progressNote: String? = null, val lastActivityAt: Long? = null)
@Serializable data class OutputFile(val path: String, val size: Long, val modifiedAt: Long)
data class Snapshot(val machine: Machine, val summary: FleetSummary?, val online: Boolean, val error: FleetError? = null)
data class ProjectRow(val snapshot: Snapshot, val project: Project)
data class MergedProject(val key: String, val name: String, val rows: List<ProjectRow>)
data class FleetState(val machines: List<Machine> = emptyList(), val snapshots: List<Snapshot> = emptyList(), val error: FleetError? = null, val busy: Boolean = false)

// The API normalizes originKey. Do not guess a Git identity from a local path.
fun projectKey(machineId: String, project: Project): String = project.git?.originKey?.takeIf { it.isNotBlank() }?.let { "git:$it" } ?: "local:$machineId:${project.cwd}"
fun mergeProjects(snapshots: List<Snapshot>): List<MergedProject> = snapshots.flatMap { snapshot ->
    snapshot.summary?.projects.orEmpty().map { ProjectRow(snapshot, it) }
}.groupBy { projectKey(it.snapshot.machine.id, it.project) }.map { (key, rows) ->
    MergedProject(key, rows.first().project.name, rows)
}.sortedBy { it.name.lowercase() }
