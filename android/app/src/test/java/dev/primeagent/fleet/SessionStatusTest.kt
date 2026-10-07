package dev.primeagent.fleet

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class SessionStatusTest {
    private fun event(raw: String) = fleetJson.decodeFromString<JsonObject>(raw)
    private fun status(raw: String, previous: String = "idle") = reduceSessionStatus(previous, event(raw))
    @Test fun actualStatusKindsStayActiveAcrossRootTurnBoundaries() {
        listOf("preparing", "running", "retrying", "retry_failed", "compacting", "children", "turn_end").forEach {
            assertEquals(it, "running", status("""{"kind":"status","status":"$it"}"""))
        }
        assertEquals("running", status("""{"kind":"session","sessionId":"s"}"""))
    }
    @Test fun pendingInteractionWaitsAndResolvedInteractionResumes() {
        assertEquals("waiting", status("""{"kind":"interaction","request":{"status":"pending"}}"""))
        assertEquals("running", status("""{"kind":"interaction","request":{"status":"answered"}}""", "waiting"))
    }
    @Test fun onlyDoneCompletesRunAndFailuresRemainErrors() {
        assertEquals("idle", status("""{"kind":"done","status":"completed","code":0}""", "running"))
        assertEquals("idle", status("""{"kind":"done","status":"stopped","code":-1}""", "running"))
        assertEquals("error", status("""{"kind":"done","status":"failed","code":-1}""", "running"))
        assertEquals("error", status("""{"kind":"done","code":1}""", "running"))
        assertEquals("waiting", status("""{"kind":"future"}""", "waiting"))
    }
    @Test fun sessionUpdateAndRoadmapLookupUseBothMachineAndSessionAcrossCheckouts() {
        fun snapshot(id: String) = Snapshot(Machine(id,id,"https://pc.example.ts.net",""), FleetSummary(Identity(machineId=id,machineName=id),1,
            listOf(Project("/first","Project", sessions=listOf(Session("other"))),Project("/second","Project",sessions=listOf(Session("s"))))),true)
        val original=FleetState(snapshots=listOf(snapshot("a"),snapshot("b")))
        val changed=original.updateSession("b","s") { it.copy(status="running",runId="run") }
        assertEquals("running",changed.linkedSession("b","s")?.status)
        assertEquals("run",changed.linkedSession("b","s")?.runId)
        assertEquals("idle",changed.linkedSession("a","s")?.status)
        assertEquals(1,changed.snapshots.last().summary!!.projects.last().activeRuns)
        assertNull(changed.linkedSession("missing","s"))
    }
    @Test fun activityUpdatePreservesRunsOutsideTheFiftySessionWindow() {
        val project=Project("/p","P",activeRuns=7,sessions=listOf(Session("s")))
        val running=project.withSessionStatuses(listOf(Session("s",status="running")))
        assertEquals(8,running.activeRuns)
        assertEquals(7,running.withSessionStatuses(listOf(Session("s"))).activeRuns)
    }
    @Test fun cachedSummariesCannotUndoSendOrDoneBeforeServerCatchesUp() {
        val old = Session("s", status="idle", runId="old")
        assertTrue(summarySessionIsStale(old, 100, 100, "new"))
        assertTrue(summarySessionIsStale(old, 101, 100, "new"))
        assertFalse(summarySessionIsStale(old.copy(runId="new"), 101, 100, "new"))
        assertTrue(summarySessionIsStale(old.copy(status="running"), 100, 100, null))
        assertFalse(summarySessionIsStale(old.copy(status="idle"), 101, 100, null))
    }
    @Test fun nullableServerTimestampDoesNotSilentlyDiscardRunningSummary() {
        val summary=fleetJson.decodeFromString<FleetSummary>("""{"machine":{"machineId":"a","machineName":"A"},"generatedAt":1,"projects":[{"cwd":"/project","name":"Project","sessions":[{"id":"s","status":"running","updatedAt":null}]}]}""")
        assertEquals("running",summary.projects.first().sessions.first().status)
        assertEquals(0L,summary.projects.first().sessions.first().updatedAt)
    }
}
