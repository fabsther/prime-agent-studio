package dev.primeagent.fleet

import kotlinx.serialization.decodeFromString
import org.junit.Assert.*
import org.junit.Test

class ModelsTest {
    private fun sample(): FleetSummary = fleetJson.decodeFromString(javaClass.getResource("/summary.json")!!.readText())
    private fun machine(id: String) = Machine(id, id, "https://pc.example.ts.net", "token")
    @Test fun parsesContractIncludingNullableFieldsAndAgentTree() {
        val summary = sample()
        assertEquals(1770000000000, summary.generatedAt)
        assertTrue(summary.projects.first().git!!.dirty)
        assertEquals("b", summary.projects.first().sessions.first().roadmapLink!!.ownerMachineId)
        assertEquals("Tests", summary.projects.first().sessions.first().agents.first().progressNote)
        assertNull(summary.projects.last().git)
        assertNull(summary.projects.last().lastActivityAt)
    }
    @Test fun gitOriginMergesButLocalPathsRemainMachineScoped() {
        val a = sample(); val b = a.copy(machine = a.machine.copy(machineId = "b"), projects = a.projects.map { it.copy(cwd = it.cwd.replace("D:/", "/home/")) })
        val projects = mergeProjects(listOf(Snapshot(machine("a"), a, true), Snapshot(machine("b"), b, false)))
        assertEquals(3, projects.size)
        val git = projects.first { it.key.startsWith("git:") }
        assertEquals(2, git.rows.size)
        assertFalse(git.rows.last().snapshot.online)
    }
    @Test fun fallbackNeverMergesSameCwdAcrossMachines() {
        val project = Project("/same", "Local", Git(originKey = null))
        assertNotEquals(projectKey("a", project), projectKey("b", project))
        assertEquals(projectKey("a", project), projectKey("a", project.copy(git = null)))
    }
    @Test fun unknownFieldsDoNotBreakContractForwardCompatibility() {
        val summary = sample()
        val raw = """{"machine":{"machineId":"a","machineName":"PC","future":true},"generatedAt":1,"projects":[],"future":{}}"""
        assertEquals("a", fleetJson.decodeFromString<FleetSummary>(raw).machine.machineId)
        assertEquals("a", summary.machine.machineId)
    }
    @Test fun onlyHttpsTailnetMachineUrlsCanReceiveTokens() {
        assertEquals("https://pc.example.ts.net", validatedBaseUrl("https://pc.example.ts.net/"))
        listOf("http://pc.example.ts.net", "https://pc.example.ts.net.evil.test", "https://user:pass@pc.example.ts.net", "https://pc.example.ts.net/api", "https://pc.example.ts.net/?pin=x", "https://pc.example.ts.net:444").forEach { url -> assertTrue(url, runCatching { validatedBaseUrl(url) }.isFailure) }
    }
}
