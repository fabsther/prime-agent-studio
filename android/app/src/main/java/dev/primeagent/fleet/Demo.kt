package dev.primeagent.fleet

import kotlinx.serialization.json.jsonObject

object Demo {
    private val now = System.currentTimeMillis()
    private val laptop = Machine("demo-laptop", "Portable", "https://portable.example.ts.net", "")
    private val tower = Machine("demo-tower", "Station", "https://station.example.ts.net", "")
    private val session = Session("demo-session", "Préparer la livraison", "running", now, "demo-run", agents = listOf(Agent("root", name = "Agent principal", status = "running", model = "gpt-6.1-sol"), Agent("review", "root", "Revue", "running", "gpt-6.1-sol", "Vérification des tests", now)))
    private fun summary(machine: Machine, running: Boolean) = FleetSummary(Identity(machineId = machine.id, machineName = machine.name, studioVersion = "4.1.5-beta.4"), now, listOf(Project(if (running) "D:/Git/Prime" else "/home/prime", "Prime Agent", Git(originKey = "github.com/example/prime", branch = if (running) "feat/fleet" else "main", dirty = running, changedFiles = if (running) 3 else 0), if (running) 1 else 0, now, listOf(if (running) session else session.copy(status = "idle", runId = null)))))
    val state = FleetState(listOf(laptop, tower), listOf(Snapshot(laptop, summary(laptop, true), true), Snapshot(tower, summary(tower, false), false)))
    val history = fleetJson.parseToJsonElement("""{"messages":[{"role":"user","text":"Prépare la livraison Fleet."},{"role":"assistant","text":"Les machines sont regroupées par dépôt. Je vérifie les tests."}]}""").jsonObject
    val roadmap = fleetJson.parseToJsonElement("""{"revision":1,"plans":[{"id":"fleet","title":"Fleet Android","steps":[{"id":"ship","text":"Vérifier la livraison","done":false,"externalLinks":[{"machineId":"demo-laptop","machineName":"Portable","sessionId":"demo-session"}]}]}]}""").jsonObject
}
