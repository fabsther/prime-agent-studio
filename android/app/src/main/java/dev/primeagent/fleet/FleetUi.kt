package dev.primeagent.fleet

import android.os.Build
import android.text.format.DateFormat
import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.flowWithLifecycle
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.*
import java.util.Date
import java.util.UUID

private val LightColors = lightColorScheme(primary = Color(0xFF5752A8), secondary = Color(0xFF42685F), background = Color(0xFFF8F8FC), surface = Color(0xFFF8F8FC))
private val DarkColors = darkColorScheme(primary = Color(0xFFC5BFFF), secondary = Color(0xFFA6CEC0), background = Color(0xFF111217), surface = Color(0xFF17181F))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetUi(vm: FleetViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var projectKey by rememberSaveable { mutableStateOf<String?>(null) }
    var sessionId by rememberSaveable { mutableStateOf<String?>(null) }
    var machineId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedCwd by rememberSaveable { mutableStateOf<String?>(null) }
    var filter by rememberSaveable { mutableStateOf<String?>(null) }
    var activeOnly by rememberSaveable { mutableStateOf(false) }
    val projects = remember(state.snapshots) { mergeProjects(state.snapshots) }
    val selected = projects.firstOrNull { it.key == projectKey }
    val row = selected?.rows?.firstOrNull { it.snapshot.machine.id == machineId && it.project.cwd == selectedCwd }
    val session = row?.project?.sessions?.firstOrNull { it.id == sessionId }
    val goBack = { if (sessionId != null) { sessionId = null; machineId = null } else projectKey = null }
    DisposableEffect(vm, projectKey) {
        vm.setDetailVisible(projectKey != null)
        onDispose { vm.setDetailVisible(false) }
    }
    BackHandler(projectKey != null, onBack = goBack)
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors) {
        Scaffold(
            topBar = {
                TopAppBar(title = {
                    Column {
                        Text(session?.title ?: selected?.name ?: stringResource(R.string.app_name), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (row != null && sessionId != null) Text(row.snapshot.machine.name, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }, navigationIcon = { if (projectKey != null) TextButton(onClick = goBack) { Text(stringResource(R.string.back)) } },
                    actions = { TextButton(onClick = vm::refresh, enabled = !state.busy) { Text(stringResource(R.string.refresh)) } })
            },
            bottomBar = {
                if (projectKey == null) NavigationBar {
                    NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = { Text("▦", style = MaterialTheme.typography.titleLarge) }, label = { Text(stringResource(R.string.projects)) })
                    NavigationBarItem(selected = tab == 1, onClick = { tab = 1 }, icon = { Text("▣", style = MaterialTheme.typography.titleLarge) }, label = { Text(stringResource(R.string.machines)) })
                }
            }
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
                Column(Modifier.widthIn(max = 840.dp).fillMaxSize()) {
                    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                    state.error?.let { ErrorNotice(it) }
                    when {
                        projectKey != null && selected == null -> EmptyNotice(R.string.missing_selection)
                        sessionId != null && (session == null || row == null) -> EmptyNotice(R.string.missing_selection)
                        session != null && row != null -> key(row.snapshot.machine.id, session.id) { SessionScreen(vm, row, session) }
                        selected != null -> key(selected.key) { ProjectScreen(vm, selected) { r, s -> machineId = r.snapshot.machine.id; selectedCwd = r.project.cwd; sessionId = s.id } }
                        tab == 1 -> MachineScreen(vm, state)
                        else -> {
                            if (state.machines.isEmpty()) Welcome(vm)
                            else {
                                Column(Modifier.padding(horizontal = 16.dp)) {
                                    Picker(stringResource(R.string.machine_filter), listOf(null to stringResource(R.string.all_machines)) + state.machines.map { it.id to it.name }, filter) { filter = it }
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Switch(checked = activeOnly, onCheckedChange = { activeOnly = it })
                                        Spacer(Modifier.width(12.dp)); Text(stringResource(R.string.active_only))
                                    }
                                }
                                val visible = projects.mapNotNull { p ->
                                    val rows = p.rows.filter { (filter == null || it.snapshot.machine.id == filter) && (!activeOnly || it.project.activeRuns > 0 || it.project.sessions.any { s -> s.status in setOf("running", "waiting") }) }
                                    if (rows.isEmpty()) null else p to rows
                                }
                                if (visible.isEmpty()) EmptyNotice(R.string.no_projects)
                                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    items(visible, key = { it.first.key }) { (p, rows) ->
                                        OutlinedCard(onClick = { projectKey = p.key }, modifier = Modifier.fillMaxWidth()) {
                                            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                                Text(p.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                                Text(rows.sumOf { it.project.activeRuns }.let { pluralStringResource(R.plurals.active_runs, it, it) }, style = MaterialTheme.typography.bodyMedium)
                                                rows.forEach { r -> ProjectMachineInfo(r) }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Welcome(vm: FleetViewModel) {
    var pair by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.no_machines), style = MaterialTheme.typography.headlineMedium)
        Text(stringResource(R.string.no_machines_help), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = { pair = true }) { Text(stringResource(R.string.add_machine)) }
        TextButton(onClick = vm::demo) { Text(stringResource(R.string.demo)) }
    }
    if (pair) PairDialog(vm) { pair = false }
}

@Composable
private fun MachineScreen(vm: FleetViewModel, state: FleetState) {
    var adding by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<Machine?>(null) }
    var removing by remember { mutableStateOf<Machine?>(null) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Button(onClick = { adding = true }, enabled = !state.busy) { Text(stringResource(R.string.add_machine)) } }
        items(state.machines, key = { it.id }) { machine ->
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(machine.name, style = MaterialTheme.typography.titleMedium)
                    Text(machine.baseUrl, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val snapshot = state.snapshots.firstOrNull { it.machine.id == machine.id }
                    MachineBadge(snapshot, machine.name)
                    snapshot?.error?.let { ErrorNotice(it) }
                    snapshot?.summary?.machine?.studioVersion?.takeIf { it.isNotBlank() }?.let { Text("Studio $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Row {
                        TextButton(onClick = { renaming = machine }, enabled = !state.busy) { Text(stringResource(R.string.rename)) }
                        TextButton(onClick = { removing = machine }, enabled = !state.busy) { Text(stringResource(R.string.remove), color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }
    }
    if (adding) PairDialog(vm) { adding = false }
    renaming?.let { machine ->
        var name by remember(machine.id) { mutableStateOf(machine.name) }
        AlertDialog(onDismissRequest = { renaming = null }, title = { Text(stringResource(R.string.rename)) }, text = {
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text(stringResource(R.string.machine_name)) }, singleLine = true)
        }, confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { vm.rename(machine.id, name.trim()); renaming = null }) { Text(stringResource(R.string.save)) } }, dismissButton = { TextButton(onClick = { renaming = null }) { Text(stringResource(R.string.cancel)) } })
    }
    removing?.let { machine ->
        ConfirmDialog(R.string.remove_title, R.string.remove_help, R.string.remove, { removing = null }) { vm.remove(machine.id); removing = null }
    }
}

@Composable
private fun PairDialog(vm: FleetViewModel, dismiss: () -> Unit) {
    var url by rememberSaveable { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf(Build.MODEL) }
    AlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.add_machine)) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.pair_help), style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(url, { url = it }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.machine_url)) }, placeholder = { Text("https://studio.example.ts.net") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), singleLine = true)
            OutlinedTextField(pin, { pin = it }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.machine_pin)) }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), singleLine = true)
            OutlinedTextField(name, { name = it }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.device_name)) }, singleLine = true)
        }
    }, confirmButton = { TextButton(enabled = url.trim().startsWith("https://") && pin.isNotBlank() && name.isNotBlank(), onClick = { vm.pair(url.trim().trimEnd('/'), pin.trim(), name.trim()); dismiss() }) { Text(stringResource(R.string.pair)) } }, dismissButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.cancel)) } })
}

@Composable
private fun ProjectScreen(vm: FleetViewModel, merged: MergedProject, openSession: (ProjectRow, Session) -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var composeRow by remember { mutableStateOf<ProjectRow?>(null) }
    Column(Modifier.fillMaxSize()) {
        TabRow(selectedTabIndex = tab) {
            listOf(R.string.sessions, R.string.roadmap, R.string.outputs).forEachIndexed { i, title -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(stringResource(title)) }) }
        }
        when (tab) {
            0 -> LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                merged.rows.forEach { row ->
                    item(key = "machine-${rowKey(row)}") {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            MachineBadge(row.snapshot)
                            Text(row.project.cwd, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            row.project.git?.let { git ->
                                git.branch?.let { Text(stringResource(R.string.branch, it), style = MaterialTheme.typography.labelMedium) }
                                if (git.dirty) Text(stringResource(R.string.changed_files, git.changedFiles), style = MaterialTheme.typography.labelMedium)
                            }
                            if (!row.snapshot.online) { OfflineNotice(); row.snapshot.error?.let { ErrorNotice(it) } }
                            TextButton(enabled = row.snapshot.online, onClick = { composeRow = row }) { Text(stringResource(R.string.new_session)) }
                            if (row.project.sessions.isEmpty()) Text(stringResource(R.string.no_sessions))
                        }
                    }
                    items(row.project.sessions, key = { "${row.snapshot.machine.id}:${it.id}" }) { session ->
                        OutlinedCard(onClick = { openSession(row, session) }, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(session.title.ifBlank { session.id }, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    StatusLabel(session.status); Text(dateText(session.updatedAt), style = MaterialTheme.typography.labelSmall)
                                }
                                Text(row.snapshot.machine.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                }
            }
            1 -> RoadmapScreen(vm, merged)
            2 -> OutputsScreen(vm, merged.rows)
        }
    }
    composeRow?.let { row -> NewSessionDialog(vm, row) { composeRow = null } }
}

@Composable
private fun NewSessionDialog(vm: FleetViewModel, row: ProjectRow, dismiss: () -> Unit) {
    var message by rememberSaveable { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<FleetError?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!sending) dismiss() }, title = { Text(stringResource(R.string.new_session)) }, text = {
        Column { Text(row.snapshot.machine.name); OutlinedTextField(message, { message = it }, label = { Text(stringResource(R.string.message)) }, minLines = 3); error?.let { ErrorNotice(it) } }
    }, confirmButton = { TextButton(enabled = message.isNotBlank() && !sending, onClick = {
        scope.launch { sending = true; try { vm.send(row.snapshot.machine, row.project, Session(id = "", title = "", status = "idle"), message.trim()); vm.refresh(); dismiss() } catch (e: Exception) { if (e is CancellationException) throw e; error = e.toFleetError() } finally { sending = false } }
    }) { Text(stringResource(if (sending) R.string.loading else R.string.send)) } }, dismissButton = { TextButton(enabled = !sending, onClick = dismiss) { Text(stringResource(R.string.cancel)) } })
}

@Composable
private fun SessionScreen(vm: FleetViewModel, row: ProjectRow, session: Session) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var history by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<FleetError?>(null) }
    var loading by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var message by rememberSaveable { mutableStateOf("") }
    var reload by remember { mutableIntStateOf(0) }
    var stopping by remember { mutableStateOf(false) }
    var liveMessages by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var assistantIndex by remember { mutableIntStateOf(-1) }
    var streamDone by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    LaunchedEffect(session.runId, row.snapshot.online, session.status in setOf("running", "waiting", "stopping")) {
        val runId = session.runId ?: return@LaunchedEffect
        if (!row.snapshot.online || session.status !in setOf("running", "waiting", "stopping")) return@LaunchedEffect
        liveMessages = emptyList(); assistantIndex = -1; streamDone = false
        var lastSeq = 0L
        try {
            vm.events(row.snapshot.machine, session.id, runId).flowWithLifecycle(lifecycle, Lifecycle.State.STARTED).collect { event ->
                val seq = (event["seq"] as? JsonPrimitive)?.longOrNull
                if (seq != null && seq <= lastSeq) return@collect
                if (seq != null) lastSeq = seq
                fun startAssistant() {
                    liveMessages = liveMessages + buildJsonObject { put("role", "assistant"); put("text", "") }
                    assistantIndex = liveMessages.lastIndex
                }
                when (event.text("kind")) {
                    "message_start" -> if (event.text("role") == "assistant") startAssistant()
                    "text" -> {
                        if (assistantIndex < 0) startAssistant()
                        liveMessages = liveMessages.mapIndexed { index, entry ->
                            if (index == assistantIndex) JsonObject(entry + ("text" to JsonPrimitive(entry.text("text") + event.text("delta")))) else entry
                        }
                    }
                    "message" -> (event["message"] as? JsonObject)?.let { incoming ->
                        if (incoming.text("role") == "assistant") {
                            if (assistantIndex < 0) startAssistant()
                            liveMessages = liveMessages.mapIndexed { index, entry -> if (index == assistantIndex) incoming else entry }
                            assistantIndex = -1
                        } else if (incoming.text("role") in setOf("user", "system")) {
                            liveMessages = liveMessages + incoming; assistantIndex = -1
                        }
                    }
                    "done" -> { streamDone = true; reload++; vm.refresh() }
                }
            }
        } catch (e: Exception) { if (e is CancellationException) throw e; error = e.toFleetError() }
    }
    LaunchedEffect(session.id, session.updatedAt, reload) {
        loading = true
        try {
            history = vm.history(row.snapshot.machine, session.id); error = null
            if (streamDone) { liveMessages = emptyList(); assistantIndex = -1 }
        }
        catch (e: Exception) { if (e is CancellationException) throw e; error = e.toFleetError() }
        finally { loading = false }
    }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            MachineBadge(row.snapshot); StatusLabel(session.status)
            if (!row.snapshot.online) { OfflineNotice(); row.snapshot.error?.let { ErrorNotice(it) } }
        }
        TabRow(selectedTabIndex = tab) {
            listOf(R.string.history, R.string.agents).forEachIndexed { i, title -> Tab(selected = tab == i, onClick = { tab = i }, text = { Text(stringResource(title)) }) }
        }
        error?.let { ErrorNotice(it) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (tab == 0) {
            val stored = history?.objects("messages").orEmpty()
            val firstUser = liveMessages.firstOrNull { it.text("role") == "user" }
            val start = if (firstUser == null) -1 else stored.indexOfLast { it.text("role") == "user" && historyText(it) == historyText(firstUser) }
            val messages = (if (start >= 0) stored.take(start) else stored) + liveMessages
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (!loading && messages.isEmpty()) item { EmptyNotice(R.string.no_history) }
                items(messages) { entry ->
                    val text = historyText(entry)
                    if (text.isNotBlank()) Surface(shape = MaterialTheme.shapes.medium, color = if (entry.text("role") == "user") MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer) {
                        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(roleLabel(entry.text("role")), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            if (entry.text("role") == "assistant") MarkdownMessage(text) else SelectionContainer { Text(text, style = MaterialTheme.typography.bodyMedium) }
                        }
                    }
                }
            }
        } else {
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (session.agents.isEmpty()) item { EmptyNotice(R.string.no_agents) }
                items(agentOrder(session.agents), key = { it.first.id }) { (agent, depth) ->
                    OutlinedCard(Modifier.fillMaxWidth().padding(start = (depth.coerceAtMost(5) * 12).dp)) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(agent.name, style = MaterialTheme.typography.titleSmall)
                            MachineBadge(row.snapshot); StatusLabel(agent.status)
                            agent.model?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            agent.progressNote?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                            agent.lastActivityAt?.let { Text(dateText(it), style = MaterialTheme.typography.labelSmall) }
                        }
                    }
                }
            }
        }
        Surface(tonalElevation = 2.dp) {
            Column(Modifier.fillMaxWidth().imePadding().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(message, { message = it }, modifier = Modifier.fillMaxWidth(), enabled = row.snapshot.online && !sending, label = { Text(stringResource(R.string.message)) }, maxLines = 5)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(enabled = row.snapshot.online && session.runId != null && session.status in setOf("running", "waiting", "stopping") && !sending, onClick = { stopping = true }) { Text(stringResource(R.string.stop), color = MaterialTheme.colorScheme.error) }
                    Button(enabled = row.snapshot.online && message.isNotBlank() && !sending, onClick = {
                        scope.launch { sending = true; try { vm.send(row.snapshot.machine, row.project, session, message.trim()); message = ""; reload++; vm.refresh() } catch (e: Exception) { if (e is CancellationException) throw e; error = e.toFleetError() } finally { sending = false } }
                    }) { Text(stringResource(if (sending) R.string.loading else if (session.status in setOf("running", "waiting")) R.string.queue_message else R.string.send)) }
                }
            }
        }
    }
    if (stopping) ConfirmDialog(R.string.stop_title, R.string.stop_help, R.string.stop, { stopping = false }) {
        stopping = false
        session.runId?.let { id -> scope.launch { try { vm.stop(row.snapshot.machine, id); vm.refresh() } catch (e: Exception) { if (e is CancellationException) throw e; error = e.toFleetError() } } }
    }
}

private fun rowKey(row: ProjectRow): String = "${row.snapshot.machine.id}:${row.project.cwd}"
private fun rowLabel(row: ProjectRow, rows: List<ProjectRow>): String = row.snapshot.machine.name +
    if (rows.count { it.snapshot.machine.id == row.snapshot.machine.id } > 1) " · ${row.project.cwd}" else ""

@Composable
private fun ProjectMachineInfo(row: ProjectRow) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        MachineBadge(row.snapshot)
        Text(pluralStringResource(R.plurals.active_runs, row.project.activeRuns, row.project.activeRuns), style = MaterialTheme.typography.bodySmall)
        row.project.git?.let { git ->
            git.branch?.let { Text(stringResource(R.string.branch, it), style = MaterialTheme.typography.labelMedium) }
            if (git.dirty) Text(stringResource(R.string.changed_files, git.changedFiles), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        }
        row.project.lastActivityAt?.let { Text(stringResource(R.string.last_activity, dateText(it)), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

private fun agentOrder(agents: List<Agent>): List<Pair<Agent, Int>> {
    val result = mutableListOf<Pair<Agent, Int>>()
    val visited = mutableSetOf<String>()
    fun visit(agent: Agent, depth: Int) {
        if (!visited.add(agent.id)) return
        result += agent to depth
        agents.filter { it.parentId == agent.id }.forEach { visit(it, depth + 1) }
    }
    agents.filter { a -> a.parentId == null || agents.none { it.id == a.parentId } }.forEach { visit(it, 0) }
    agents.forEach { visit(it, 0) } // Keep malformed/cyclic server trees visible, without recursion loops.
    return result
}

@Composable
private fun OutputsScreen(vm: FleetViewModel, rows: List<ProjectRow>) {
    var selectedRow by rememberSaveable { mutableStateOf(rows.firstOrNull()?.let { rowKey(it) }) }
    val row = rows.firstOrNull { rowKey(it) == selectedRow } ?: rows.firstOrNull() ?: return
    var files by remember { mutableStateOf<List<OutputFile>>(emptyList()) }
    var error by remember { mutableStateOf<FleetError?>(null) }
    var loading by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(rowKey(row), reload) {
        files = emptyList(); loading = true
        try { files = vm.outputs(row.snapshot.machine, row.project.cwd); error = null }
        catch (e: Exception) { if (e is CancellationException) throw e; error = e.toFleetError() }
        finally { loading = false }
    }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(16.dp)) {
            Picker(stringResource(R.string.machines), rows.map { rowKey(it) to rowLabel(it, rows) }, rowKey(row)) { selectedRow = it }
            if (!row.snapshot.online) { OfflineNotice(); row.snapshot.error?.let { ErrorNotice(it) } }
            TextButton(enabled = row.snapshot.online && !loading, onClick = { reload++ }) { Text(stringResource(R.string.refresh)) }
        }
        error?.let { ErrorNotice(it) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!loading && files.isEmpty()) item { EmptyNotice(R.string.no_outputs) }
            items(files, key = { "${rowKey(row)}:${it.path}" }) { file -> key(rowKey(row), file.path) { OutputCard(row, file) } }
        }
    }
}

@Composable
private fun OutputCard(row: ProjectRow, file: OutputFile) {
    val context = LocalContext.current
    var workId by rememberSaveable { mutableStateOf<String?>(null) }
    val workFlow = remember(workId) { workId?.let { WorkManager.getInstance(context).getWorkInfoByIdFlow(UUID.fromString(it)) } }
    val work = workFlow?.collectAsStateWithLifecycle(initialValue = null)?.value
    var error by remember { mutableStateOf<FleetError?>(null) }
    val failedText = stringResource(R.string.download_failed)
    val openFailed = stringResource(R.string.open_failed)
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(file.path, style = MaterialTheme.typography.titleSmall)
            Text("${Formatter.formatFileSize(context, file.size)} · ${dateText(file.modifiedAt)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (work != null && !work.state.isFinished) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(stringResource(R.string.download_pending), style = MaterialTheme.typography.labelSmall) }
            if (work?.state == WorkInfo.State.FAILED || work?.state == WorkInfo.State.CANCELLED) Text(work.outputData.getString("error") ?: failedText, color = MaterialTheme.colorScheme.error)
            error?.let { Text(context.errorText(it), color = MaterialTheme.colorScheme.error) }
            Row {
                if (work?.state == WorkInfo.State.SUCCEEDED && work.outputData.getString("uri") != null) {
                    TextButton(onClick = {
                        try { Downloads.open(context, work.outputData.getString("uri")!!, work.outputData.getString("mimeType") ?: "application/octet-stream"); error = null }
                        catch (e: Exception) { error = FleetError.Localized(openFailed) }
                    }) { Text(stringResource(R.string.open)) }
                }
                TextButton(enabled = row.snapshot.online && (work == null || work.state.isFinished), onClick = {
                    try { workId = Downloads.enqueue(context, row.snapshot.machine.id, row.project.cwd, file.path).toString(); error = null }
                    catch (e: Exception) { error = e.toFleetError() }
                }) { Text(stringResource(R.string.download)) }
            }
        }
    }
}

@Composable
private fun RoadmapScreen(vm: FleetViewModel, merged: MergedProject) {
    val fleetState by vm.state.collectAsStateWithLifecycle()
    val savedOwner = remember(merged.key) { vm.owner(merged.key) }
    var ownerId by rememberSaveable { mutableStateOf(savedOwner ?: merged.rows.firstOrNull()?.snapshot?.machine?.id) }
    var ownerResolved by rememberSaveable { mutableStateOf(merged.rows.any { it.snapshot.machine.id == savedOwner }) }
    var ownerCwd by rememberSaveable { mutableStateOf<String?>(null) }
    val owner = merged.rows.firstOrNull { it.snapshot.machine.id == ownerId && (ownerCwd == null || it.project.cwd == ownerCwd) } ?: merged.rows.firstOrNull() ?: return
    val cache = remember { mutableStateMapOf<String, JsonObject>() }
    val document = cache[rowKey(owner)]
    var error by remember { mutableStateOf<FleetError?>(null) }
    var loading by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var selectedStep by remember { mutableStateOf<Pair<String, JsonObject>?>(null) }
    LaunchedEffect(merged.key) {
        if (ownerResolved) return@LaunchedEffect
        loading = true
        val discovered = coroutineScope {
            merged.rows.map { candidate -> async {
                try { candidate to vm.roadmap(candidate.snapshot.machine, candidate.project.cwd) }
                catch (e: Exception) { if (e is CancellationException) throw e; null }
            } }.awaitAll().filterNotNull()
        }
        discovered.forEach { (candidate, value) -> cache[rowKey(candidate)] = value }
        if (!ownerResolved) {
            val choice = discovered.firstOrNull { (_, value) -> (value["initialized"] as? JsonPrimitive)?.booleanOrNull == true || value.objects("plans").isNotEmpty() }
                ?: discovered.firstOrNull()
            ownerId = choice?.first?.snapshot?.machine?.id ?: ownerId
            ownerCwd = choice?.first?.project?.cwd
            ownerId?.let { vm.setOwner(merged.key, it) }
            ownerResolved = true
        }
        loading = false
    }
    LaunchedEffect(rowKey(owner), ownerResolved, reload) {
        if (!ownerResolved) return@LaunchedEffect
        loading = true; error = null
        try { cache[rowKey(owner)] = vm.roadmap(owner.snapshot.machine, owner.project.cwd) }
        catch (e: Exception) { if (e is CancellationException) throw e; error = e.toFleetError() }
        finally { loading = false }
    }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Picker(stringResource(R.string.roadmap_owner), merged.rows.map { rowKey(it) to rowLabel(it, merged.rows) }, rowKey(owner)) { id ->
                merged.rows.firstOrNull { rowKey(it) == id }?.let { choice -> ownerId = choice.snapshot.machine.id; ownerCwd = choice.project.cwd; ownerResolved = true; vm.setOwner(merged.key, choice.snapshot.machine.id) }
            }
            Text(stringResource(R.string.owner_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!owner.snapshot.online) { OfflineNotice(); owner.snapshot.error?.let { ErrorNotice(it) } }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                document?.get("revision")?.jsonPrimitive?.longOrNull?.let { Text(stringResource(R.string.revision, it), style = MaterialTheme.typography.labelSmall) }
                TextButton(enabled = owner.snapshot.online && !loading, onClick = { reload++ }) { Text(stringResource(R.string.refresh)) }
            }
        }
        error?.let { ErrorNotice(it) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        val plans = document?.objects("plans").orEmpty().filter { (it["archived"] as? JsonPrimitive)?.booleanOrNull != true }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!loading && plans.isEmpty()) item { EmptyNotice(R.string.no_roadmap) }
            plans.forEach { plan ->
                item(key = plan.text("id")) {
                    Text(plan.text("title"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    plan.text("summary").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
                items(flatSteps(plan.objects("steps")), key = { "${plan.text("id")}:${it.first.text("id")}" }) { (step, depth) ->
                    val done = (step["done"] as? JsonPrimitive)?.booleanOrNull == true
                    OutlinedCard(Modifier.fillMaxWidth().padding(start = (depth * 12).dp)) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = done, onCheckedChange = null)
                                Text(step.text("text"), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                            }
                            step.text("note").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            (step.objects("externalLinks") + step.objects("externalActivity")).forEach { link ->
                                Text(stringResource(R.string.delegated_to, link.text("machineName").ifBlank { link.text("machineId") }), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                                val targetSession = fleetState.linkedSession(link.text("machineId"), link.text("sessionId"))
                                StatusLabel(targetSession?.status ?: "unknown")
                            }
                            TextButton(enabled = !done && owner.snapshot.online && document != null && !loading, onClick = { selectedStep = plan.text("id") to step }) { Text(stringResource(R.string.delegate)) }
                        }
                    }
                }
            }
        }
    }
    selectedStep?.let { (planId, step) ->
        DelegateDialog(vm, owner, merged.rows.filter { it.snapshot.online }, planId, step, document?.get("revision")?.jsonPrimitive?.longOrNull, { selectedStep = null }) { selectedStep = null; reload++; vm.refresh() }
    }
}

@Composable
private fun DelegateDialog(vm: FleetViewModel, owner: ProjectRow, targets: List<ProjectRow>, planId: String, step: JsonObject, revision: Long?, dismiss: () -> Unit, complete: () -> Unit) {
    var targetId by rememberSaveable { mutableStateOf((targets.firstOrNull { it.snapshot.machine.id != owner.snapshot.machine.id } ?: targets.firstOrNull())?.let { rowKey(it) }) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var targetStarted by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<FleetError?>(null) }
    val scope = rememberCoroutineScope()
    val target = targets.firstOrNull { rowKey(it) == targetId }
    AlertDialog(onDismissRequest = { if (!sending) dismiss() }, title = { Text(stringResource(R.string.delegate_title)) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(step.text("text"), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(R.string.delegate_help), style = MaterialTheme.typography.bodySmall)
            if (targets.isEmpty()) Text(stringResource(R.string.no_targets))
            else Picker(stringResource(R.string.delegate_target), targets.map { rowKey(it) to rowLabel(it, targets) }, targetId) { targetId = it }
            OutlinedTextField(prompt, { prompt = it }, label = { Text(stringResource(R.string.delegate_prompt)) }, minLines = 2, maxLines = 5, modifier = Modifier.fillMaxWidth())
            error?.let { ErrorNotice(it) }
        }
    }, confirmButton = { TextButton(enabled = target != null && !sending && !targetStarted && revision != null, onClick = {
        scope.launch { sending = true; try { vm.delegate(owner, target!!, planId, step.text("id"), step.text("text"), prompt.trim(), revision); complete() } catch (e: Exception) { if (e is CancellationException) throw e; if (e is DelegationLinkException) targetStarted = true; error = e.toFleetError(); vm.refresh() } finally { sending = false } }
    }) { Text(stringResource(if (sending) R.string.loading else R.string.delegate)) } }, dismissButton = { TextButton(enabled = !sending, onClick = dismiss) { Text(stringResource(R.string.cancel)) } })
}

private fun flatSteps(steps: List<JsonObject>, depth: Int = 0): List<Pair<JsonObject, Int>> = steps.flatMap { listOf(it to depth) + if (depth < 3) flatSteps(it.objects("children"), depth + 1) else emptyList() }
private fun JsonObject.text(key: String): String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun JsonObject.objects(key: String): List<JsonObject> = (get(key) as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
private fun historyText(message: JsonObject): String = message.text("text").ifBlank {
    message.text("content").ifBlank { message.objects("content").filter { it.text("type") == "text" }.joinToString("\n") { it.text("text") } }
}

@Composable
private fun dateText(timestamp: Long): String {
    val context = LocalContext.current
    return if (timestamp <= 0) stringResource(R.string.unknown_date) else DateFormat.getMediumDateFormat(context).format(Date(timestamp)) + " " + DateFormat.getTimeFormat(context).format(Date(timestamp))
}

@Composable
private fun roleLabel(role: String): String = stringResource(when (role) { "user" -> R.string.you; "assistant" -> R.string.assistant; "tool", "toolResult" -> R.string.tool; else -> R.string.system })

@Composable
private fun StatusLabel(status: String) {
    val label = when (status) { "running" -> R.string.status_running; "waiting" -> R.string.status_waiting; "idle" -> R.string.status_idle; "error", "failed" -> R.string.status_error; "done", "completed" -> R.string.status_done; "stopping" -> R.string.status_stopping; else -> R.string.status_other }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (status == "running") CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
        Text(stringResource(label, status), style = MaterialTheme.typography.labelMedium, color = when (status) { "running", "waiting" -> MaterialTheme.colorScheme.primary; "error", "failed" -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.onSurfaceVariant })
    }
}

@Composable
private fun MachineBadge(snapshot: Snapshot?, name: String = "") {
    Surface(shape = MaterialTheme.shapes.small, color = if (snapshot?.online == true) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHighest) {
        Text("${snapshot?.machine?.name ?: name} · ${stringResource(if (snapshot?.online == true) R.string.online else R.string.offline)}", Modifier.padding(horizontal = 10.dp, vertical = 6.dp), style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
private fun <T> Picker(label: String, options: List<Pair<T, String>>, selected: T, change: (T) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) {
                Text(options.firstOrNull { it.first == selected }?.second.orEmpty(), modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(" ▾")
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                options.forEach { (value, text) -> DropdownMenuItem(text = { Text(text) }, onClick = { change(value); expanded = false }) }
            }
        }
    }
}

@Composable
private fun ErrorNotice(error: FleetError) {
    val message = LocalContext.current.errorText(error)
    Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), shape = MaterialTheme.shapes.small) {
        Text(stringResource(R.string.error_prefix, message), Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
    }
}

@Composable
private fun OfflineNotice() { Text(stringResource(R.string.cached_data), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp)) }

@Composable
private fun EmptyNotice(label: Int) { Text(stringResource(label), Modifier.padding(24.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }

@Composable
private fun ConfirmDialog(title: Int, message: Int, action: Int, dismiss: () -> Unit, confirm: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(title)) }, text = { Text(stringResource(message)) }, confirmButton = { TextButton(onClick = confirm) { Text(stringResource(action), color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.cancel)) } })
}
