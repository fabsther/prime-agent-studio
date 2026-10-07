package dev.primeagent.fleet

import kotlinx.serialization.json.*

/** Real Studio SSE kinds. A turn_end is NOT run completion: retained/background work can resume. */
fun reduceSessionStatus(current: String, event: JsonObject): String {
    fun text(key: String) = (event[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
    return when (text("kind")) {
        "session", "message_start", "text", "tool_start" -> "running"
        "status" -> when (text("status")) {
            "waiting" -> "waiting"
            "error", "failed" -> "error"
            "running", "preparing", "retrying", "retry_failed", "compacting", "children", "turn_end", "stopping" -> "running"
            else -> current
        }
        "interaction" -> if ((event["request"] as? JsonObject)?.get("status")?.jsonPrimitive?.contentOrNull == "pending") "waiting" else "running"
        "done" -> if (text("status") in setOf("failed", "error") ||
            ((event["code"] as? JsonPrimitive)?.intOrNull ?: 0) != 0 && text("status") != "stopped") "error" else "idle"
        else -> current
    }
}

fun FleetState.updateSession(machineId: String, sessionId: String, change: (Session) -> Session): FleetState = copy(
    snapshots = snapshots.map { snapshot ->
        if (snapshot.machine.id != machineId) snapshot else snapshot.copy(summary = snapshot.summary?.let { summary ->
            summary.copy(projects = summary.projects.map { project ->
                val sessions = project.sessions.map { if (it.id == sessionId) change(it) else it }
                project.withSessionStatuses(sessions)
            })
        })
    }
)

/** External links are machine + session scoped, not cwd/first checkout scoped. */
fun FleetState.linkedSession(machineId: String, sessionId: String): Session? = snapshots
    .firstOrNull { it.machine.id == machineId }?.summary?.projects.orEmpty()
    .flatMap { it.sessions }.firstOrNull { it.id == sessionId }

/** Studio summaries are cached for five seconds; older cached state cannot undo a local event. */
fun summarySessionIsStale(session: Session, generatedAt: Long, localBarrier: Long?, pendingRunId: String?): Boolean =
    (localBarrier != null && generatedAt <= localBarrier) || (pendingRunId != null && session.runId != pendingRunId)

/** Summary sessions are capped at 50; preserve active runs omitted from that window. */
fun Project.withSessionStatuses(updated: List<Session>): Project {
    fun active(sessions: List<Session>) = sessions.count { it.status in setOf("running", "waiting") }
    return copy(sessions = updated, activeRuns = (activeRuns + active(updated) - active(sessions)).coerceAtLeast(0))
}
